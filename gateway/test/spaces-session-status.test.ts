import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { runCron } from "../src/index";
import type { ProviderCall } from "../src/router/providers/types";
import {
  checkSessionToken,
  hashIp,
  issueSession,
  readCookie,
  sessionCookie,
  verifyTurnstile,
} from "../src/session";
import { callSpace, collectResult, mapGradioError, parseSse, reemit } from "../src/spaces/gradio";
import { clearRuntimeCache, ensureAwake } from "../src/spaces/runtime";
import { buildStatus } from "../src/status";
import { parseGatewayError } from "../src/types";

const URL_ = "https://adityajajodia-tarka.hf.space";
type Route = (url: string, init?: RequestInit) => Response | undefined;
function fakeFetch(...routes: Route[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, ...(init ? { init } : {}) });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return res;
    }
    return new Response("no route", { status: 599 });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

describe("M3 Gradio proxy (fake Gradio server)", () => {
  const sse =
    'event: generating\ndata: ["Hel"]\n\nevent: generating\ndata: ["Hello"]\n\nevent: complete\ndata: ["Hello world"]\n\n';
  const gradio = (stream = sse) =>
    fakeFetch(
      (u, i) =>
        u === `${URL_}/gradio_api/call/predict` && i?.method === "POST"
          ? Response.json({ event_id: "ev1" })
          : undefined,
      (u) =>
        u === `${URL_}/gradio_api/call/predict/ev1`
          ? new Response(stream, { headers: { "content-type": "text/event-stream" } })
          : undefined,
    );

  it("parses SSE events", () => {
    expect(parseSse(sse).map((e) => e.event)).toEqual(["generating", "generating", "complete"]);
  });

  it("calls a Space and returns the complete event's data, sending the HF token", async () => {
    const g = gradio();
    const stream = await callSpace(URL_, "hf_test", "predict", ["hi"], g.fetch);
    expect(await collectResult(stream, URL_)).toEqual(["Hello world"]);
    expect(new Headers(g.calls[0]!.init!.headers).get("authorization")).toBe("Bearer hf_test");
    expect(JSON.parse(g.calls[0]!.init!.body as string)).toEqual({ data: ["hi"] });
  });

  it("re-emits Gradio SSE as token/done events", async () => {
    const out = await reemit(await callSpace(URL_, "t", "predict", [], gradio().fetch), URL_).text();
    expect(parseSse(out).map((e) => [e.event, e.data])).toEqual([
      ["token", '["Hel"]'],
      ["token", '["Hello"]'],
      ["done", '["Hello world"]'],
    ]);
  });

  it("maps the ZeroGPU quota error to capacity_exhausted with the Space link; queue/timeouts to timeout", async () => {
    const quota = gradio(
      'event: error\ndata: "You have exceeded your GPU quota (60s requested vs. 0s left)."\n\n',
    );
    const err = await collectResult(await callSpace(URL_, "t", "predict", [], quota.fetch), URL_).catch((e) =>
      parseGatewayError(e),
    );
    expect(err).toMatchObject({ code: "capacity_exhausted" });
    expect((err as { message: string }).message).toContain(URL_);
    expect(parseGatewayError(mapGradioError("Queue is full", URL_))?.code).toBe("timeout");
    expect(parseGatewayError(mapGradioError("Space is sleeping", URL_))?.code).toBe("waking");
  });

  it("restarts a sleeping Space and reports waking (~90 s); running stays running", async () => {
    clearRuntimeCache();
    const sleeping = fakeFetch(
      (u) => (u.endsWith("/runtime") ? Response.json({ stage: "SLEEPING" }) : undefined),
      (u, i) => (u.endsWith("/restart") && i?.method === "POST" ? new Response("{}") : undefined),
    );
    expect(await ensureAwake("adityajajodia/tarka", "t", sleeping.fetch, 1)).toEqual({
      state: "waking",
      etaS: 90,
    });
    expect(sleeping.calls.map((c) => c.url.split("/").at(-1))).toEqual(["runtime", "restart"]);
    clearRuntimeCache();
    const running = fakeFetch((u) =>
      u.endsWith("/runtime") ? Response.json({ stage: "RUNNING" }) : undefined,
    );
    expect(await ensureAwake("adityajajodia/tarka", "t", running.fetch, 2)).toEqual({ state: "running" });
  });
});

describe("M4 sessions", () => {
  const KEY = "test-session-key";

  it("issues a token that verifies for the same IP hash", async () => {
    const ip = await hashIp("203.0.113.7", KEY);
    const { token } = await issueSession(KEY, ip);
    expect(await checkSessionToken(KEY, token, ip)).toMatchObject({ ok: true });
  });

  it("rejects tampering, another key, another IP and expiry", async () => {
    const now = Date.parse("2026-10-14T12:00:00Z");
    const ip = await hashIp("203.0.113.7", KEY, now);
    const { token } = await issueSession(KEY, ip, now);
    const [p, s] = token.split(".");
    const forged = btoa(atob(p!.replace(/-/g, "+").replace(/_/g, "/")).replace(/\.\d+\./, ".9999999999."))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect((await checkSessionToken(KEY, `${forged}.${s}`, ip, now)).reason).toBe("bad_signature");
    expect((await checkSessionToken("other-key", token, ip, now)).reason).toBe("bad_signature");
    expect((await checkSessionToken(KEY, token, await hashIp("198.51.100.1", KEY, now), now)).reason).toBe(
      "ip_mismatch",
    );
    expect((await checkSessionToken(KEY, token, ip, now + 2 * 3600 * 1000 + 1)).reason).toBe("expired");
    expect((await checkSessionToken(KEY, "garbage", ip, now)).ok).toBe(false);
  });

  it("IP hashes are salted per UTC day (raw IPs are never stored)", async () => {
    const a = await hashIp("203.0.113.7", KEY, Date.parse("2026-10-14T01:00:00Z"));
    const b = await hashIp("203.0.113.7", KEY, Date.parse("2026-10-15T01:00:00Z"));
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies Turnstile with the secret, token and remote IP (Cloudflare test secret keys)", async () => {
    const pass = fakeFetch((u) => (u.includes("siteverify") ? Response.json({ success: true }) : undefined));
    expect(
      await verifyTurnstile(
        "1x0000000000000000000000000000000AA",
        "XXXX.DUMMY.TOKEN.XXXX",
        "203.0.113.7",
        pass.fetch,
      ),
    ).toBe(true);
    const form = pass.calls[0]!.init!.body as FormData;
    expect([form.get("secret"), form.get("response"), form.get("remoteip")]).toEqual([
      "1x0000000000000000000000000000000AA",
      "XXXX.DUMMY.TOKEN.XXXX",
      "203.0.113.7",
    ]);
    const fail = fakeFetch((u) =>
      u.includes("siteverify")
        ? Response.json({ success: false, "error-codes": ["invalid-input-response"] })
        : undefined,
    );
    expect(
      await verifyTurnstile("2x0000000000000000000000000000000AA", "XXXX.DUMMY.TOKEN.XXXX", null, fail.fetch),
    ).toBe(false);
    expect(await verifyTurnstile("1x0000000000000000000000000000000AA", "", null, pass.fetch)).toBe(false);
  });

  it("builds an HttpOnly, Secure, SameSite=Lax 2-hour cookie and reads it back", () => {
    const c = sessionCookie("abc.def");
    expect(c).toBe("aj_s=abc.def; Max-Age=7200; Path=/; HttpOnly; Secure; SameSite=Lax");
    expect(readCookie("x=1; aj_s=abc.def; y=2")).toBe("abc.def");
  });
});

describe("M5 status and cron", () => {
  const ledger = () => env.LEDGER.get(env.LEDGER.idFromName(`s-${crypto.randomUUID()}`));

  it("status reflects a forced breaker and today's usage; disabled projects are not_deployed", async () => {
    const l = ledger();
    for (let i = 0; i < 3; i++) await l.recordFailure("groq", 3, 300_000);
    await l.record({ project: "satya", pool: "neurons", amount: 1500 });
    const s = await buildStatus(env, l);
    expect(s.providers.groq.breaker).toBe("open");
    expect(s.providers.workersai).toMatchObject({ breaker: "closed", neuronsLeft: 8500 });
    expect(s.projects.satya).toMatchObject({ live: true, state: "live", neuronsLeft: 3000 });
    expect(s.projects.tarka).toEqual({ live: false, state: "not_deployed" });
    expect(s.spaces).toEqual({ tarka: "not_deployed", examlens: "not_deployed" });
  });

  it("status shows capacity when Satya's budgets are used, and down when both breakers are open", async () => {
    const l = ledger();
    await l.record({ project: "satya", pool: "neurons", amount: 4500 });
    await l.record({ project: "satya", pool: "groq", amount: 100_000 });
    expect((await buildStatus(env, l)).projects.satya!.state).toBe("capacity");
    const l2 = ledger();
    for (const p of ["workersai", "groq"]) for (let i = 0; i < 3; i++) await l2.recordFailure(p, 3, 300_000);
    expect((await buildStatus(env, l2)).projects.satya!.state).toBe("down");
  });

  it("cron: skips undeployed Spaces, self-tests Workers AI (≤ 50 neurons) and writes cron_log", async () => {
    const l = ledger();
    const ai: ProviderCall = async () => ({ text: "OK", usage: { input: 20, output: 5 }, neurons: 1.2 });
    await runCron(env, l, ai);
    const log = await l.recentCron(10);
    expect(log.map((r) => [r.job, r.ok])).toEqual(
      expect.arrayContaining([
        ["space:tarka", true],
        ["space:examlens", true],
        ["selftest", true],
      ]),
    );
    expect((await l.usage()).reserve!.neurons).toBe(1.2);
  });

  it("GET /api/status serves JSON with CORS for adityajajodia.com", async () => {
    const res = await SELF.fetch("https://aj-demos.pages.dev/api/status", {
      headers: { Origin: "https://adityajajodia.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://adityajajodia.com");
    expect(await res.json()).toMatchObject({
      providers: { workersai: { breaker: "closed" } },
      projects: { satya: { live: true } },
    });
    const other = await SELF.fetch("https://aj-demos.pages.dev/api/status", {
      headers: { Origin: "https://evil.example" },
    });
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("POST /api/admin/llm requires the admin bearer token", async () => {
    const res = await SELF.fetch("https://aj-demos.pages.dev/api/admin/llm", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });
});
