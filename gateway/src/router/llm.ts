// Model router (Platform M2): cache → estimate → provider order (pin | workersai → groq) with breakers and
// budgets → call with timeout → retries with full-jitter backoff (honouring Retry-After) → JSON-schema
// validation with one repair → settle real usage → capacity_exhausted / provider_down.
import { Validator } from "@cfworker/json-schema";
import { LIMITS, MODELS, estimateTokens, inEvalWindow, neuronsFor } from "../config";
import type { LedgerDO } from "../ledger";
import {
  GatewayError,
  type LlmRequest,
  type LlmResult,
  type Provider,
  secondsUntilUtcMidnight,
} from "../types";
import { ProviderError, type ProviderCall, type ProviderReply } from "./providers/types";

export const REPAIR_MESSAGE = "Return only valid JSON matching the schema";
const DEFAULT_MAX_TOKENS = 1024;

export interface RouterDeps {
  ledger: DurableObjectStub<LedgerDO>;
  providers: Record<Provider, ProviderCall>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

type Skip = "breaker" | "capacity" | "failed";

/** Full jitter: random in [0, min(maxMs, base·2^attempt)]; a Retry-After hint wins when larger. */
export function backoffMs(attempt: number, random: number, retryAfterMs?: number): number {
  const ceiling = Math.min(LIMITS.retries.maxMs, LIMITS.retries.baseMs * 2 ** attempt);
  return Math.max(retryAfterMs ?? 0, Math.floor(random * ceiling));
}

export function parseJsonLoose(text: string): unknown {
  const t = text.trim();
  for (const candidate of [
    t,
    t.replace(/^```(?:json)?\s*|\s*```$/g, ""),
    t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1),
  ]) {
    try {
      return JSON.parse(candidate);
    } catch {
      // next candidate
    }
  }
  return undefined;
}

function validate(schema: object, value: unknown): boolean {
  if (value === undefined) return false;
  return new Validator(schema as never, "2020-12", false).validate(value).valid;
}

export async function routeLlm(req: LlmRequest, deps: RouterDeps): Promise<LlmResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = deps.random ?? Math.random;
  const { ledger } = deps;
  const started = now();

  // 1. cache
  if (req.cacheKey) {
    if (!req.cacheKey.startsWith(`${req.project}:`))
      throw new GatewayError("bad_request", "cacheKey must be namespaced '<project>:...'");
    const hit = await ledger.cacheGet(req.cacheKey, now());
    if (hit) return { ...(JSON.parse(hit) as LlmResult), cached: true, latencyMs: now() - started };
  }

  // 2. estimate
  const inTok = estimateTokens(req.messages.map((m) => m.content).join("\n"));
  const outTok = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const estNeurons = neuronsFor(MODELS.text.workersai, inTok, outTok);
  const estTokens = inTok + outTok;
  const margin = 1 + LIMITS.safetyMargin;

  // 3b. eval class: only inside the window, only from capacity left unused by everyone (minus the reserve)
  const evalClass = req.budgetClass === "eval";
  if (evalClass) {
    const w = inEvalWindow(now());
    if (!w.open)
      throw new GatewayError(
        "capacity_exhausted",
        "evaluation runs only inside the nightly window",
        w.opensInS,
      );
  }

  // 3. provider order
  const order: Provider[] = req.pin ? [req.pin.provider] : ["workersai", "groq"];
  const skipped: Skip[] = [];
  for (const provider of order) {
    const breaker = await ledger.breakerState(provider, LIMITS.breaker.failures, now());
    if (breaker.state === "open") {
      skipped.push("breaker");
      continue;
    }
    const pool = provider === "workersai" ? "neurons" : "groq";
    const amount = provider === "workersai" ? estNeurons : estTokens;
    const projectKey = evalClass ? `${req.project}:eval` : req.project;
    const cap = evalClass
      ? provider === "workersai"
        ? LIMITS.workersaiDailyNeurons - LIMITS.budgets.reserve
        : LIMITS.groqDailyTokens
      : provider === "workersai"
        ? ((LIMITS.budgets as Record<string, number>)[req.project] ?? 0)
        : LIMITS.groqDailyTokens * ((LIMITS.groqShare as Record<string, number>)[req.project] ?? 0);
    const reservation = await ledger.reserve({
      project: projectKey,
      pool,
      amount,
      need: amount * margin,
      cap,
      scope: evalClass ? "total" : "project",
      now: now(),
    });
    if (!reservation.ok) {
      skipped.push("capacity");
      continue;
    }

    try {
      const model = MODELS.text[provider];
      let reply = await callWithRetries(deps.providers[provider], req, model, { sleep, random });
      let used = usageOf(provider, reply);
      let json: unknown;
      if (req.jsonSchema) {
        json = parseJsonLoose(reply.text);
        if (!validate(req.jsonSchema, json)) {
          // 6. one repair attempt on the same provider
          const repair: LlmRequest = {
            ...req,
            messages: [
              ...req.messages,
              { role: "assistant", content: reply.text },
              { role: "user", content: REPAIR_MESSAGE },
            ],
          };
          reply = await callWithRetries(deps.providers[provider], repair, model, { sleep, random });
          used += usageOf(provider, reply);
          json = parseJsonLoose(reply.text);
          if (!validate(req.jsonSchema, json)) {
            await ledger.settle({ project: projectKey, pool, reserved: amount, actual: used, now: now() });
            await ledger.recordSuccess(provider);
            throw new GatewayError("bad_output", `${provider} returned invalid JSON after one repair`);
          }
        }
      }
      // 7. accounting
      await ledger.settle({ project: projectKey, pool, reserved: amount, actual: used, now: now() });
      await ledger.recordSuccess(provider);
      const result: LlmResult = {
        text: reply.text,
        ...(json === undefined ? {} : { json }),
        provider,
        model,
        usage: reply.usage,
        ...(provider === "workersai" ? { neurons: used } : {}),
        latencyMs: now() - started,
        cached: false,
      };
      if (req.cacheKey)
        await ledger.cachePut(req.cacheKey, JSON.stringify(result), LIMITS.cacheTtlDays, now());
      return result;
    } catch (e) {
      if (e instanceof GatewayError) throw e;
      await ledger.settle({ project: projectKey, pool, reserved: amount, actual: 0, now: now() });
      await ledger.recordFailure(provider, LIMITS.breaker.failures, LIMITS.breaker.openMs, now());
      skipped.push("failed");
    }
  }

  // 8. nothing could serve the request
  // Out of budget somewhere and no provider actually failed → capacity; otherwise the providers are down.
  if (skipped.includes("capacity") && !skipped.includes("failed")) {
    throw new GatewayError(
      "capacity_exhausted",
      "today's free capacity is used",
      secondsUntilUtcMidnight(now()),
    );
  }
  throw new GatewayError(
    "provider_down",
    "all model providers are unavailable",
    Math.ceil(LIMITS.breaker.openMs / 1000),
  );
}

/** Neurons (Workers AI: reported, else priced from tokens) or tokens (Groq). */
function usageOf(provider: Provider, reply: ProviderReply): number {
  if (provider === "groq") return reply.usage.input + reply.usage.output;
  return reply.neurons ?? neuronsFor(MODELS.text.workersai, reply.usage.input, reply.usage.output);
}

async function callWithRetries(
  call: ProviderCall,
  req: LlmRequest,
  model: string,
  { sleep, random }: { sleep: (ms: number) => Promise<void>; random: () => number },
): Promise<ProviderReply> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(req, model, AbortSignal.timeout(LIMITS.timeouts.llmMs));
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError(String((e as Error)?.message ?? e), 0);
      if (!err.retryable || attempt >= LIMITS.retries.max) throw err;
      await sleep(backoffMs(attempt, random(), err.retryAfterMs));
    }
  }
}
