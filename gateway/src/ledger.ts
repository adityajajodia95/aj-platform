// LedgerDO (Platform M1): one global SQLite Durable Object (`idFromName("ledger")`) holding daily budgets,
// per-IP limits, the result cache, provider circuit breakers and the cron log. Every method is synchronous
// SQL inside a single request (no awaits), and a Durable Object processes one request at a time, so
// check-then-reserve is atomic: two concurrent reserves can never exceed a budget.
import { DurableObject } from "cloudflare:workers";
import { utcDay } from "./types";

export type Pool = "neurons" | "groq";
const MAX_CACHE_VALUE_BYTES = 512 * 1024;
const RETENTION_DAYS = 7;

export interface BreakerState {
  provider: string;
  state: "closed" | "open" | "half_open";
  failures: number;
  openUntil: number;
}

export class LedgerDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS budget (day TEXT NOT NULL, project TEXT NOT NULL, neurons REAL NOT NULL DEFAULT 0,
                                         groq_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, project));
      CREATE TABLE IF NOT EXISTS ip_usage (day TEXT NOT NULL, ip_hash TEXT NOT NULL, key TEXT NOT NULL,
                                           count INTEGER NOT NULL, PRIMARY KEY (day, ip_hash, key));
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS breaker (provider TEXT PRIMARY KEY, failures INTEGER NOT NULL, open_until INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cron_log (ts INTEGER NOT NULL, job TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // ── budgets ─────────────────────────────────────────────────────────────────────────────────────

  private column(pool: Pool): "neurons" | "groq_tokens" {
    return pool === "neurons" ? "neurons" : "groq_tokens";
  }

  private usedBy(day: string, project: string, pool: Pool): number {
    const rows = this.sql
      .exec<{ v: number }>(
        `SELECT ${this.column(pool)} AS v FROM budget WHERE day = ? AND project = ?`,
        day,
        project,
      )
      .toArray();
    return rows[0]?.v ?? 0;
  }

  private usedTotal(day: string, pool: Pool): number {
    return (
      this.sql
        .exec<{ v: number | null }>(`SELECT SUM(${this.column(pool)}) AS v FROM budget WHERE day = ?`, day)
        .one().v ?? 0
    );
  }

  private add(day: string, project: string, pool: Pool, amount: number): void {
    const col = this.column(pool);
    this.sql.exec(
      `INSERT INTO budget (day, project, ${col}) VALUES (?, ?, MAX(0, ?))
       ON CONFLICT (day, project) DO UPDATE SET ${col} = MAX(0, ${col} + ?)`,
      day,
      project,
      amount,
      amount,
    );
  }

  /**
   * Reserves `amount` against `project`'s daily `cap` if `used + need ≤ cap` (need = estimate × (1 + safety
   * margin)). `scope: "total"` checks the sum over all projects instead (eval class: leftover capacity only).
   */
  reserve(args: {
    project: string;
    pool: Pool;
    amount: number;
    need: number;
    cap: number;
    scope?: "project" | "total";
    now?: number;
  }) {
    const now = args.now ?? Date.now();
    const day = utcDay(now);
    this.maintain(now);
    const used =
      args.scope === "total" ? this.usedTotal(day, args.pool) : this.usedBy(day, args.project, args.pool);
    if (used + args.need > args.cap) return { ok: false, used, cap: args.cap };
    this.add(day, args.project, args.pool, args.amount);
    return { ok: true, used: used + args.amount, cap: args.cap };
  }

  /** Replaces a reservation by the real usage (`actual` 0 releases it). */
  settle(args: { project: string; pool: Pool; reserved: number; actual: number; now?: number }): void {
    this.add(utcDay(args.now ?? Date.now()), args.project, args.pool, args.actual - args.reserved);
  }

  /** Records usage reported by a provider without a reservation (e.g. embeddings). */
  record(args: { project: string; pool: Pool; amount: number; now?: number }): void {
    const now = args.now ?? Date.now();
    this.maintain(now);
    this.add(utcDay(now), args.project, args.pool, args.amount);
  }

  usage(now = Date.now()): Record<string, { neurons: number; groqTokens: number }> {
    const rows = this.sql
      .exec<{ project: string; neurons: number; groq_tokens: number }>(
        "SELECT project, neurons, groq_tokens FROM budget WHERE day = ?",
        utcDay(now),
      )
      .toArray();
    return Object.fromEntries(
      rows.map((r) => [r.project, { neurons: r.neurons, groqTokens: r.groq_tokens }]),
    );
  }

  // ── per-IP limits ───────────────────────────────────────────────────────────────────────────────

  consumeIp(args: { ipHash: string; key: string; limit: number; amount?: number; now?: number }) {
    const now = args.now ?? Date.now();
    const day = utcDay(now);
    this.maintain(now);
    const amount = args.amount ?? 1;
    const used =
      this.sql
        .exec<{ count: number }>(
          "SELECT count FROM ip_usage WHERE day = ? AND ip_hash = ? AND key = ?",
          day,
          args.ipHash,
          args.key,
        )
        .toArray()[0]?.count ?? 0;
    const resetAt = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString();
    if (used + amount > args.limit) return { ok: false, remaining: Math.max(0, args.limit - used), resetAt };
    this.sql.exec(
      "INSERT INTO ip_usage (day, ip_hash, key, count) VALUES (?, ?, ?, ?) ON CONFLICT (day, ip_hash, key) DO UPDATE SET count = count + excluded.count",
      day,
      args.ipHash,
      args.key,
      amount,
    );
    return { ok: true, remaining: args.limit - used - amount, resetAt };
  }

  // ── cache ───────────────────────────────────────────────────────────────────────────────────────

  cacheGet(key: string, now = Date.now()): string | null {
    const row = this.sql
      .exec<{ value: string; expires: number }>("SELECT value, expires FROM cache WHERE key = ?", key)
      .toArray()[0];
    if (!row) return null;
    if (row.expires <= now) {
      this.sql.exec("DELETE FROM cache WHERE key = ?", key);
      return null;
    }
    return row.value;
  }

  /** Values over 512 KB are not cached (returns false). */
  cachePut(key: string, value: string, ttlDays: number, now = Date.now()): boolean {
    if (new TextEncoder().encode(value).byteLength > MAX_CACHE_VALUE_BYTES) return false;
    this.maintain(now);
    this.sql.exec(
      "INSERT OR REPLACE INTO cache (key, value, created, expires) VALUES (?, ?, ?, ?)",
      key,
      value,
      now,
      now + ttlDays * 86_400_000,
    );
    return true;
  }

  // ── circuit breakers ────────────────────────────────────────────────────────────────────────────

  breakerState(provider: string, threshold: number, now = Date.now()): BreakerState {
    const row = this.sql
      .exec<{ failures: number; open_until: number }>(
        "SELECT failures, open_until FROM breaker WHERE provider = ?",
        provider,
      )
      .toArray()[0];
    const failures = row?.failures ?? 0;
    const openUntil = row?.open_until ?? 0;
    const state = openUntil > now ? "open" : failures >= threshold ? "half_open" : "closed";
    return { provider, state, failures, openUntil };
  }

  recordSuccess(provider: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO breaker (provider, failures, open_until) VALUES (?, 0, 0)",
      provider,
    );
  }

  /** closed → open after `threshold` consecutive failures (for `openMs`); a failure while half-open re-opens it. */
  recordFailure(provider: string, threshold: number, openMs: number, now = Date.now()): BreakerState {
    const prev = this.breakerState(provider, threshold, now);
    const failures = prev.failures + 1;
    const openUntil = failures >= threshold ? now + openMs : prev.openUntil;
    this.sql.exec(
      "INSERT OR REPLACE INTO breaker (provider, failures, open_until) VALUES (?, ?, ?)",
      provider,
      failures,
      openUntil,
    );
    return this.breakerState(provider, threshold, now);
  }

  // ── cron log, summary, maintenance ──────────────────────────────────────────────────────────────

  cronLog(job: string, ok: boolean, detail: string, now = Date.now()): void {
    this.sql.exec(
      "INSERT INTO cron_log (ts, job, ok, detail) VALUES (?, ?, ?, ?)",
      now,
      job,
      ok ? 1 : 0,
      detail.slice(0, 500),
    );
  }

  recentCron(limit = 20): { ts: number; job: string; ok: boolean; detail: string }[] {
    return this.sql
      .exec<{ ts: number; job: string; ok: number; detail: string }>(
        "SELECT ts, job, ok, detail FROM cron_log ORDER BY ts DESC LIMIT ?",
        limit,
      )
      .toArray()
      .map((r) => ({ ...r, ok: r.ok === 1 }));
  }

  summary(threshold: number, now = Date.now()) {
    return {
      day: utcDay(now),
      usage: this.usage(now),
      breakers: ["workersai", "groq"].map((p) => this.breakerState(p, threshold, now)),
      cacheEntries: this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cache").one().n,
      lastCron: this.recentCron(1)[0] ?? null,
    };
  }

  /** On the first write of each UTC day: drop rows older than 7 days and expired cache entries. */
  private maintain(now: number): void {
    const day = utcDay(now);
    const last = this.sql
      .exec<{ v: string }>("SELECT v FROM meta WHERE k = 'last_purge_day'")
      .toArray()[0]?.v;
    if (last === day) return;
    const cutoff = utcDay(now - RETENTION_DAYS * 86_400_000);
    this.sql.exec("DELETE FROM budget WHERE day < ?", cutoff);
    this.sql.exec("DELETE FROM ip_usage WHERE day < ?", cutoff);
    this.sql.exec("DELETE FROM cron_log WHERE ts < ?", now - RETENTION_DAYS * 86_400_000);
    this.sql.exec("DELETE FROM cache WHERE expires <= ?", now);
    this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('last_purge_day', ?)", day);
  }
}
