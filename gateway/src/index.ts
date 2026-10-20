// aj-gateway (Platform_Development.md §3): RPC entrypoint for project Workers (service bindings), HTTP for
// /api/status, /api/session and /api/admin/llm (via the Pages router), and the 6-hourly cron.
import { WorkerEntrypoint } from "cloudflare:workers";
import { LIMITS, SPACES } from "./config";
import type { LedgerDO } from "./ledger";
import { embedTexts, rerankPassages } from "./router/embed";
import { routeLlm } from "./router/llm";
import { groq } from "./router/providers/groq";
import type { ProviderCall } from "./router/providers/types";
import { workersAi } from "./router/providers/workersai";
import { checkSessionToken, hashIp, issueSession, sessionCookie, verifyTurnstile } from "./session";
import { callSpace, collectResult, reemit, uploadFiles } from "./spaces/gradio";
import { ensureAwake } from "./spaces/runtime";
import { buildStatus, enabledProjects } from "./status";
import { GatewayError, type LlmRequest, type LlmResult, type Project, parseGatewayError } from "./types";

export { LedgerDO } from "./ledger";

const STATUS_CACHE_MS = 30_000;
const STATUS_ORIGINS = new Set(["https://adityajajodia.com", "https://www.adityajajodia.com"]);
let statusCache: { at: number; body: string } | null = null;

const errorBody = (
  code: string,
  message: string,
  retryAfterS = 0,
  fallback: "gallery" | "none" = "none",
) => ({
  error: { code, message, retryAfterS, fallback },
});

/** Standard error body (§3.2): 429 limits, 503 waking/provider_down, 507 capacity_exhausted, 400 validation. */
export function errorResponse(e: unknown): Response {
  const g = parseGatewayError(e);
  if (!g)
    return Response.json(errorBody("internal", "unexpected error"), {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  const status =
    g.code === "capacity_exhausted"
      ? 507
      : g.code === "rate_limited"
        ? 429
        : g.code === "bad_request" || g.code === "bad_output"
          ? 400
          : 503;
  const fallback =
    g.code === "capacity_exhausted" || g.code === "provider_down" || g.code === "waking" ? "gallery" : "none";
  return Response.json(errorBody(g.code, g.message, g.retryAfterS, fallback), {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(g.retryAfterS ? { "Retry-After": String(g.retryAfterS) } : {}),
    },
  });
}

export default class Gateway extends WorkerEntrypoint<Env> {
  private get ledger(): DurableObjectStub<LedgerDO> {
    return this.env.LEDGER.get(this.env.LEDGER.idFromName("ledger"));
  }

  // ── RPC (service bindings from project Workers) ─────────────────────────────────────────────────

  llm(req: LlmRequest): Promise<LlmResult> {
    return routeLlm(req, {
      ledger: this.ledger,
      providers: { workersai: workersAi(this.env.AI), groq: groq(this.env.GROQ_API_KEY) },
    });
  }

  embed(req: { project: Project; texts: string[]; kind: "query" | "doc" }): Promise<number[][]> {
    return embedTexts(this.env.AI, this.ledger, req.texts);
  }

  rerank(req: { project: Project; query: string; passages: string[] }): Promise<number[]> {
    return rerankPassages(this.env.AI, this.ledger, req.query, req.passages);
  }

  async space(req: {
    project: "tarka" | "examlens";
    api: string;
    data: unknown[];
    files?: { name: string; bytes: ArrayBuffer }[];
    stream?: boolean;
  }): Promise<Response> {
    const cfg = SPACES[req.project];
    const token = this.env.HF_TOKEN;
    if (!cfg || !token || !enabledProjects(this.env).includes(req.project)) {
      throw new GatewayError("provider_down", `${req.project} Space is not deployed`);
    }
    const awake = await ensureAwake(cfg.repo, token);
    if (awake.state === "waking") throw new GatewayError("waking", "Space is waking up", awake.etaS);
    const paths = req.files?.length ? await uploadFiles(cfg.url, token, req.files) : [];
    const data = paths.length ? [...req.data, ...paths.map((path) => ({ path }))] : req.data;
    const stream = await callSpace(cfg.url, token, req.api, data, fetch, LIMITS.timeouts.spaceMs);
    return req.stream ? reemit(stream, cfg.url) : Response.json(await collectResult(stream, cfg.url));
  }

  /** Callers hash the visitor IP here so they never need SESSION_KEY. */
  hashIp(ip: string): Promise<string> {
    return hashIp(ip, this.env.SESSION_KEY);
  }

  async checkSession(req: { token: string; ipHash: string }): Promise<{ ok: boolean; sessionId?: string }> {
    const r = await checkSessionToken(this.env.SESSION_KEY, req.token, req.ipHash);
    return r.sessionId ? { ok: r.ok, sessionId: r.sessionId } : { ok: r.ok };
  }

  consume(req: {
    project: Project;
    kind: "run" | "turn" | "generation" | "answer" | "mcp" | "embed";
    ipHash: string;
    amount?: number;
  }) {
    const key = `${req.project}:${req.kind}`;
    const limit = (LIMITS.perIpDaily as Record<string, number>)[key];
    if (limit === undefined) throw new GatewayError("bad_request", `no per-IP limit configured for ${key}`);
    return this.ledger.consumeIp({
      ipHash: req.ipHash,
      key,
      limit,
      ...(req.amount ? { amount: req.amount } : {}),
    });
  }

  async remaining(project: Project): Promise<{ neurons: number; groqTokens: number; live: boolean }> {
    const p = (await buildStatus(this.env, this.ledger)).projects[project];
    return { neurons: p?.neuronsLeft ?? 0, groqTokens: p?.groqTokensLeft ?? 0, live: Boolean(p?.live) };
  }

  cacheGet(key: string): Promise<string | null> {
    return this.ledger.cacheGet(key);
  }

  async cachePut(key: string, value: string, ttlDays?: number): Promise<void> {
    if (!/^[a-z-]+:/.test(key))
      throw new GatewayError("bad_request", "cache keys must be namespaced '<project>:...'");
    await this.ledger.cachePut(key, value, ttlDays ?? LIMITS.cacheTtlDays);
  }

  // ── HTTP ────────────────────────────────────────────────────────────────────────────────────────

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/status" && (request.method === "GET" || request.method === "OPTIONS"))
        return await this.status(request);
      if (url.pathname === "/api/session" && request.method === "POST") return await this.session(request);
      if (url.pathname === "/api/admin/llm" && request.method === "POST") return await this.adminLlm(request);
      return Response.json(errorBody("not_found", "No such route"), {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    } catch (e) {
      return errorResponse(e);
    }
  }

  private async status(request: Request): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors: Record<string, string> =
      origin && STATUS_ORIGINS.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    const now = Date.now();
    if (!statusCache || now - statusCache.at > STATUS_CACHE_MS) {
      statusCache = { at: now, body: JSON.stringify(await buildStatus(this.env, this.ledger, now)) };
    }
    return new Response(statusCache.body, {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30", ...cors },
    });
  }

  private async session(request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as { turnstileToken?: string };
    const ip = request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
    if (!(await verifyTurnstile(this.env.TURNSTILE_SECRET, body.turnstileToken ?? "", ip))) {
      return Response.json(errorBody("turnstile_failed", "Verification failed — please retry"), {
        status: 403,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const { token, exp } = await issueSession(this.env.SESSION_KEY, await hashIp(ip, this.env.SESSION_KEY));
    return Response.json(
      { ok: true, expiresAt: new Date(exp * 1000).toISOString() },
      { headers: { "Set-Cookie": sessionCookie(token), "Cache-Control": "no-store" } },
    );
  }

  private async adminLlm(request: Request): Promise<Response> {
    if (request.headers.get("Authorization") !== `Bearer ${this.env.ADMIN_TOKEN}`) {
      return Response.json(errorBody("unauthorized", "Bearer token required"), {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const req = (await request.json()) as LlmRequest;
    return Response.json(await this.llm({ ...req, budgetClass: "eval" }), {
      headers: { "Cache-Control": "no-store" },
    });
  }

  // ── cron (every 6 h) ────────────────────────────────────────────────────────────────────────────

  override async scheduled(_controller: ScheduledController): Promise<void> {
    await runCron(this.env, this.ledger, workersAi(this.env.AI));
  }
}

/** Space wake-ups (enabled Spaces only), a tiny Workers AI self-test (≤ 50 neurons), purge, cron_log. */
export async function runCron(
  env: Env,
  ledger: DurableObjectStub<LedgerDO>,
  ai: ProviderCall,
): Promise<void> {
  for (const project of ["tarka", "examlens"] as const) {
    const space = SPACES[project];
    if (!space || !env.HF_TOKEN || !enabledProjects(env).includes(project)) {
      await ledger.cronLog(`space:${project}`, true, "skipped: not deployed");
      continue;
    }
    const s = await ensureAwake(space.repo, env.HF_TOKEN);
    await ledger.cronLog(`space:${project}`, s.state !== "error", JSON.stringify(s));
  }
  try {
    const reply = await ai(
      {
        project: "satya",
        task: "selftest",
        messages: [{ role: "user", content: "Reply with OK." }],
        maxTokens: 16,
        reasoning: "low",
      },
      "@cf/openai/gpt-oss-120b",
      AbortSignal.timeout(30_000),
    );
    const neurons = reply.neurons ?? 0;
    await ledger.record({ project: "reserve", pool: "neurons", amount: neurons }); // also triggers the daily purge
    await ledger.cronLog("selftest", true, `ok; ${neurons.toFixed(2)} neurons`);
  } catch (e) {
    await ledger.cronLog("selftest", false, (e as Error).message);
  }
}
