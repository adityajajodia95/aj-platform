import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/config";
import { REPAIR_MESSAGE, backoffMs, routeLlm, type RouterDeps } from "../src/router/llm";
import { parseDurationMs } from "../src/router/providers/groq";
import { ProviderError, type ProviderCall, type ProviderReply } from "../src/router/providers/types";
import { parseGatewayError, type LlmRequest } from "../src/types";

const NOON = Date.parse("2026-10-14T12:00:00Z");
const ledger = () => env.LEDGER.get(env.LEDGER.idFromName(`r-${crypto.randomUUID()}`));
const reply = (text: string, input = 1000, output = 200, neurons?: number): ProviderReply => ({
  text,
  usage: { input, output },
  ...(neurons === undefined ? {} : { neurons }),
});

/** A scripted provider: each call takes the next step (a reply or an error). */
function scripted(...steps: (ProviderReply | ProviderError)[]): ProviderCall & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const fn = (async (req: LlmRequest) => {
    calls.push(req);
    const step = steps[Math.min(calls.length - 1, steps.length - 1)]!;
    if (step instanceof ProviderError) throw step;
    return step;
  }) as unknown as ProviderCall & { calls: LlmRequest[] };
  fn.calls = calls;
  return fn;
}

const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  project: "satya",
  task: "judge",
  messages: [{ role: "user", content: "Is the Eiffel Tower in Paris?" }],
  maxTokens: 300,
  ...over,
});

function deps(workersai: ProviderCall, groq: ProviderCall, at = NOON): RouterDeps & { slept: number[] } {
  const slept: number[] = [];
  return {
    ledger: ledger(),
    providers: { workersai, groq },
    now: () => at,
    sleep: async (ms) => void slept.push(ms),
    random: () => 0.5,
    slept,
  };
}

const code = async (p: Promise<unknown>) =>
  parseGatewayError(
    await p.then(
      () => null,
      (e: unknown) => e,
    ),
  )?.code;

describe("router: provider chain", () => {
  it("success on Workers AI; neurons settled from usage", async () => {
    const d = deps(scripted(reply("ok", 85, 111, 10.27)), scripted(reply("never")));
    const r = await routeLlm(req(), d);
    expect(r).toMatchObject({
      text: "ok",
      provider: "workersai",
      model: "@cf/openai/gpt-oss-120b",
      neurons: 10.27,
      cached: false,
    });
    expect((await d.ledger.usage(NOON)).satya!.neurons).toBeCloseTo(10.27, 6);
  });

  it("429 → retry (full jitter, honouring Retry-After) → success", async () => {
    const wai = scripted(new ProviderError("rate limited", 429, 3000), reply("ok", 10, 10, 1));
    const d = deps(wai, scripted(reply("never")));
    expect((await routeLlm(req(), d)).provider).toBe("workersai");
    expect(wai.calls).toHaveLength(2);
    expect(d.slept).toEqual([3000]);
  });

  it("Workers AI budget exhausted → Groq; Groq tokens settled", async () => {
    const d = deps(scripted(reply("never")), scripted(reply("from groq", 500, 120)));
    await d.ledger.record({ project: "satya", pool: "neurons", amount: LIMITS.budgets.satya, now: NOON });
    const r = await routeLlm(req(), d);
    expect(r.provider).toBe("groq");
    expect((await d.ledger.usage(NOON)).satya!.groqTokens).toBe(620);
  });

  it("Workers AI failing after retries → falls over to Groq and the failure is released from the budget", async () => {
    const wai = scripted(new ProviderError("upstream", 503));
    const d = deps(wai, scripted(reply("groq ok", 100, 20)));
    const r = await routeLlm(req(), d);
    expect(r.provider).toBe("groq");
    expect(wai.calls).toHaveLength(1 + LIMITS.retries.max);
    expect((await d.ledger.usage(NOON)).satya!.neurons).toBe(0);
  });

  it("both budgets used → capacity_exhausted with retryAfterS until 00:00 UTC", async () => {
    const d = deps(scripted(reply("x")), scripted(reply("x")));
    await d.ledger.record({ project: "satya", pool: "neurons", amount: LIMITS.budgets.satya, now: NOON });
    await d.ledger.record({
      project: "satya",
      pool: "groq",
      amount: LIMITS.groqDailyTokens * LIMITS.groqShare.satya,
      now: NOON,
    });
    const err = await routeLlm(req(), d).catch((e: unknown) => parseGatewayError(e));
    expect(err).toMatchObject({ code: "capacity_exhausted", retryAfterS: 12 * 3600 });
  });

  it("both providers failing → provider_down", async () => {
    const d = deps(scripted(new ProviderError("down", 503)), scripted(new ProviderError("down", 500)));
    expect(await code(routeLlm(req(), d))).toBe("provider_down");
  });

  it("a pinned run uses only its provider", async () => {
    const wai = scripted(reply("never"));
    const d = deps(wai, scripted(reply("pinned groq", 10, 10)));
    expect((await routeLlm(req({ pin: { provider: "groq" } }), d)).provider).toBe("groq");
    expect(wai.calls).toHaveLength(0);
  });
});

describe("router: structured output", () => {
  const schema = {
    type: "object",
    properties: { label: { type: "string", enum: ["SUPPORTED", "REFUTED"] } },
    required: ["label"],
    additionalProperties: false,
  };

  it("validates JSON and returns it parsed", async () => {
    const d = deps(scripted(reply('{"label":"SUPPORTED"}')), scripted(reply("never")));
    expect((await routeLlm(req({ jsonSchema: schema }), d)).json).toEqual({ label: "SUPPORTED" });
  });

  it("one repair attempt on the same provider, with the repair message", async () => {
    const wai = scripted(reply('{"label":"MAYBE"}', 10, 10, 1), reply('{"label":"REFUTED"}', 10, 10, 1));
    const d = deps(wai, scripted(reply("never")));
    const r = await routeLlm(req({ jsonSchema: schema }), d);
    expect(r.json).toEqual({ label: "REFUTED" });
    expect(wai.calls[1]!.messages.at(-1)).toEqual({ role: "user", content: REPAIR_MESSAGE });
    expect((await d.ledger.usage(NOON)).satya!.neurons).toBe(2); // both attempts are paid for
  });

  it("still invalid after the repair → bad_output", async () => {
    const d = deps(scripted(reply("not json")), scripted(reply("never")));
    expect(await code(routeLlm(req({ jsonSchema: schema }), d))).toBe("bad_output");
  });
});

describe("router: breaker", () => {
  it("opens after 3 failed requests (skipping Workers AI), then closes after a success", async () => {
    const failing = scripted(new ProviderError("down", 503));
    const d = deps(failing, scripted(reply("groq", 10, 10)));
    for (let i = 0; i < LIMITS.breaker.failures; i++) await routeLlm(req(), d);
    expect((await d.ledger.breakerState("workersai", 3, NOON)).state).toBe("open");
    const calls = failing.calls.length;
    await routeLlm(req(), d); // skipped while open
    expect(failing.calls).toHaveLength(calls);
    // after openMs the breaker is half-open; a success closes it
    const later = {
      ...d,
      now: () => NOON + LIMITS.breaker.openMs + 1,
      providers: { workersai: scripted(reply("back", 1, 1, 0.1)), groq: d.providers.groq },
    };
    expect((await routeLlm(req(), later)).provider).toBe("workersai");
    expect((await d.ledger.breakerState("workersai", 3, NOON + LIMITS.breaker.openMs + 2)).state).toBe(
      "closed",
    );
  });
});

describe("router: cache and eval class", () => {
  it("a cache hit returns {cached: true} without calling a provider", async () => {
    const wai = scripted(reply("first", 10, 10, 1));
    const d = deps(wai, scripted(reply("never")));
    await routeLlm(req({ cacheKey: "satya:q1" }), d);
    const hit = await routeLlm(req({ cacheKey: "satya:q1" }), d);
    expect(hit).toMatchObject({ text: "first", cached: true });
    expect(wai.calls).toHaveLength(1);
    expect(await code(routeLlm(req({ cacheKey: "other:q1" }), d))).toBe("bad_request");
  });

  it("eval class is refused outside 18:30–23:50 UTC with retryAfterS until the window opens", async () => {
    const d = deps(scripted(reply("x")), scripted(reply("x")));
    const err = await routeLlm(req({ budgetClass: "eval" }), d).catch((e: unknown) => parseGatewayError(e));
    expect(err).toMatchObject({ code: "capacity_exhausted", retryAfterS: 6.5 * 3600 });
  });

  it("eval class inside the window uses only leftover capacity (all projects, minus the reserve)", async () => {
    const at = Date.parse("2026-10-14T19:00:00Z");
    const d = deps(scripted(reply("x", 10, 10, 1)), scripted(new ProviderError("down", 503)), at);
    await d.ledger.record({ project: "kaaran", pool: "neurons", amount: 9490, now: at });
    expect(await code(routeLlm(req({ budgetClass: "eval" }), d))).toBe("provider_down"); // WAI leftover too small; Groq failed
    const d2 = deps(scripted(reply("x", 10, 10, 1)), scripted(reply("never")), at);
    expect((await routeLlm(req({ budgetClass: "eval" }), d2)).provider).toBe("workersai");
    expect((await d2.ledger.usage(at))["satya:eval"]!.neurons).toBe(1);
  });
});

describe("router helpers", () => {
  it("backoff is full jitter capped at maxMs, Retry-After wins", () => {
    expect(backoffMs(0, 0.5)).toBe(400);
    expect(backoffMs(5, 1)).toBe(LIMITS.retries.maxMs);
    expect(backoffMs(0, 0.1, 5000)).toBe(5000);
  });

  it("parses Groq reset durations", () => {
    expect(parseDurationMs("6m24.5s")).toBe(384_500);
    expect(parseDurationMs("450ms")).toBe(450);
    expect(parseDurationMs("2")).toBe(2000);
    expect(parseDurationMs(null)).toBeUndefined();
  });
});
