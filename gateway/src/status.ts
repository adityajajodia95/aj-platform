// Status (Platform M5): providers (breaker + what is left today), Spaces, per-project liveness, reset time.
import { LIMITS } from "./config";
import type { LedgerDO } from "./ledger";
import { PROJECTS, type Project, utcDay } from "./types";

export interface Status {
  updatedAt: string;
  providers: {
    workersai: { breaker: string; neuronsLeft: number };
    groq: { breaker: string; tokensLeft: number };
  };
  spaces: Record<string, string>;
  projects: Record<
    string,
    {
      live: boolean;
      state: "live" | "capacity" | "down" | "not_deployed";
      neuronsLeft?: number;
      groqTokensLeft?: number;
    }
  >;
  resetsAt: string;
  lastCron: { ts: number; job: string; ok: boolean } | null;
}

export function enabledProjects(env: Env): Project[] {
  return String(env.ENABLED_PROJECTS ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter((p): p is Project => (PROJECTS as readonly string[]).includes(p));
}

export async function buildStatus(
  env: Env,
  ledger: DurableObjectStub<LedgerDO>,
  now = Date.now(),
): Promise<Status> {
  const summary = await ledger.summary(LIMITS.breaker.failures, now);
  const usage = summary.usage;
  const used = (key: string, pool: "neurons" | "groqTokens") =>
    Object.entries(usage)
      .filter(([k]) => k === key || k.startsWith(`${key}:`))
      .reduce((s, [, u]) => s + u[pool], 0);
  const totalNeurons = Object.values(usage).reduce((s, u) => s + u.neurons, 0);
  const totalGroq = Object.values(usage).reduce((s, u) => s + u.groqTokens, 0);
  const breaker = (p: string) => summary.breakers.find((b) => b.provider === p)?.state ?? "closed";
  const enabled = new Set(enabledProjects(env));
  const budgets = LIMITS.budgets as Record<string, number>;
  const shares = LIMITS.groqShare as Record<string, number>;

  const projects: Status["projects"] = {};
  for (const p of PROJECTS) {
    if (!enabled.has(p)) {
      projects[p] = { live: false, state: "not_deployed" };
      continue;
    }
    const neuronsLeft = Math.max(0, (budgets[p] ?? 0) - used(p, "neurons"));
    const groqTokensLeft = Math.max(0, LIMITS.groqDailyTokens * (shares[p] ?? 0) - used(p, "groqTokens"));
    const providersUp = breaker("workersai") !== "open" || breaker("groq") !== "open";
    const hasCapacity = neuronsLeft > 0 || groqTokensLeft > 0;
    projects[p] = {
      live: providersUp && hasCapacity,
      state: !providersUp ? "down" : hasCapacity ? "live" : "capacity",
      neuronsLeft: Math.round(neuronsLeft),
      groqTokensLeft: Math.round(groqTokensLeft),
    };
  }
  const tomorrow = Date.parse(`${utcDay(now)}T00:00:00Z`) + 86_400_000;
  return {
    updatedAt: new Date(now).toISOString(),
    providers: {
      workersai: {
        breaker: breaker("workersai"),
        neuronsLeft: Math.max(0, Math.round(LIMITS.workersaiDailyNeurons - totalNeurons)),
      },
      groq: {
        breaker: breaker("groq"),
        tokensLeft: Math.max(0, Math.round(LIMITS.groqDailyTokens - totalGroq)),
      },
    },
    // Tarka and ExamLens Spaces are not deployed in this build (scope C1).
    spaces: {
      tarka: enabled.has("tarka") ? "unknown" : "not_deployed",
      examlens: enabled.has("examlens") ? "unknown" : "not_deployed",
    },
    projects,
    resetsAt: new Date(tomorrow).toISOString(),
    lastCron: summary.lastCron
      ? { ts: summary.lastCron.ts, job: summary.lastCron.job, ok: summary.lastCron.ok }
      : null,
  };
}
