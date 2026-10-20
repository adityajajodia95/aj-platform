import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { LedgerDO } from "../src/ledger";

const fresh = () => env.LEDGER.get(env.LEDGER.idFromName(`t-${crypto.randomUUID()}`));
const NOON = Date.parse("2026-10-14T12:00:00Z");

describe("LedgerDO budgets", () => {
  it("two concurrent reserves cannot exceed a budget", async () => {
    const ledger = fresh();
    const req = {
      project: "satya",
      pool: "neurons" as const,
      amount: 3000,
      need: 3150,
      cap: 4500,
      now: NOON,
    };
    const [a, b] = await Promise.all([ledger.reserve(req), ledger.reserve(req)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect((await ledger.usage(NOON)).satya!.neurons).toBe(3000);
  });

  it("settle replaces the reservation with actual usage; actual 0 releases it", async () => {
    const ledger = fresh();
    await ledger.reserve({ project: "satya", pool: "neurons", amount: 700, need: 735, cap: 4500, now: NOON });
    await ledger.settle({ project: "satya", pool: "neurons", reserved: 700, actual: 512.5, now: NOON });
    expect((await ledger.usage(NOON)).satya!.neurons).toBe(512.5);
    await ledger.reserve({ project: "satya", pool: "neurons", amount: 100, need: 105, cap: 4500, now: NOON });
    await ledger.settle({ project: "satya", pool: "neurons", reserved: 100, actual: 0, now: NOON });
    expect((await ledger.usage(NOON)).satya!.neurons).toBe(512.5);
  });

  it("the safety margin is checked: need > cap − used refuses even if the estimate itself fits", async () => {
    const ledger = fresh();
    expect(
      (
        await ledger.reserve({
          project: "satya",
          pool: "neurons",
          amount: 4400,
          need: 4620,
          cap: 4500,
          now: NOON,
        })
      ).ok,
    ).toBe(false);
  });

  it("total scope (eval class) counts every project's usage", async () => {
    const ledger = fresh();
    await ledger.record({ project: "satya", pool: "neurons", amount: 4000, now: NOON });
    await ledger.record({ project: "kaaran", pool: "neurons", amount: 4000, now: NOON });
    expect(
      (
        await ledger.reserve({
          project: "satya:eval",
          pool: "neurons",
          amount: 600,
          need: 630,
          cap: 9200,
          now: NOON,
          scope: "total",
        })
      ).ok,
    ).toBe(true);
    expect(
      (
        await ledger.reserve({
          project: "satya:eval",
          pool: "neurons",
          amount: 600,
          need: 630,
          cap: 9200,
          now: NOON,
          scope: "total",
        })
      ).ok,
    ).toBe(false);
  });

  it("budgets are per UTC day", async () => {
    const ledger = fresh();
    await ledger.record({ project: "satya", pool: "groq", amount: 100_000, now: NOON });
    const tomorrow = NOON + 86_400_000;
    expect(
      (
        await ledger.reserve({
          project: "satya",
          pool: "groq",
          amount: 1000,
          need: 1050,
          cap: 100_000,
          now: tomorrow,
        })
      ).ok,
    ).toBe(true);
  });
});

describe("LedgerDO per-IP limits", () => {
  it("allows `limit` per day, then refuses, and resets at 00:00 UTC", async () => {
    const ledger = fresh();
    const call = (now = NOON) => ledger.consumeIp({ ipHash: "h1", key: "satya:run", limit: 3, now });
    const results = [await call(), await call(), await call(), await call()];
    expect(results.map((r) => [r.ok, r.remaining])).toEqual([
      [true, 2],
      [true, 1],
      [true, 0],
      [false, 0],
    ]);
    expect(results[3]!.resetAt).toBe("2026-10-15T00:00:00.000Z");
    expect((await ledger.consumeIp({ ipHash: "h2", key: "satya:run", limit: 3, now: NOON })).ok).toBe(true);
    expect((await call(NOON + 86_400_000)).ok).toBe(true);
  });
});

describe("LedgerDO breakers", () => {
  it("closed → open after 3 failures → half-open after 5 min → closed on success; half-open failure re-opens", async () => {
    const ledger = fresh();
    for (let i = 0; i < 2; i++) await ledger.recordFailure("groq", 3, 300_000, NOON);
    expect((await ledger.breakerState("groq", 3, NOON)).state).toBe("closed");
    expect((await ledger.recordFailure("groq", 3, 300_000, NOON)).state).toBe("open");
    expect((await ledger.breakerState("groq", 3, NOON + 299_000)).state).toBe("open");
    expect((await ledger.breakerState("groq", 3, NOON + 300_001)).state).toBe("half_open");
    expect((await ledger.recordFailure("groq", 3, 300_000, NOON + 300_001)).state).toBe("open");
    await ledger.recordSuccess("groq");
    expect((await ledger.breakerState("groq", 3, NOON + 700_000)).state).toBe("closed");
  });
});

describe("LedgerDO cache", () => {
  it("expires after the TTL and refuses values over 512 KB", async () => {
    const ledger = fresh();
    expect(await ledger.cachePut("satya:k", "v", 30, NOON)).toBe(true);
    expect(await ledger.cacheGet("satya:k", NOON + 29 * 86_400_000)).toBe("v");
    expect(await ledger.cacheGet("satya:k", NOON + 30 * 86_400_000 + 1)).toBeNull();
    expect(await ledger.cachePut("satya:big", "x".repeat(512 * 1024 + 1), 30, NOON)).toBe(false);
  });
});

describe("LedgerDO maintenance", () => {
  it("purges rows older than 7 days on the first write of a day", async () => {
    const ledger = fresh();
    const old = NOON - 8 * 86_400_000;
    await ledger.record({ project: "satya", pool: "neurons", amount: 10, now: old });
    await ledger.consumeIp({ ipHash: "h", key: "k", limit: 3, now: old });
    await ledger.record({ project: "satya", pool: "neurons", amount: 1, now: NOON }); // first write today
    await runInDurableObject(ledger, (instance: LedgerDO, state) => {
      expect(instance).toBeDefined();
      const rows = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM budget").one().n;
      const ips = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM ip_usage").one().n;
      expect([rows, ips]).toEqual([1, 0]);
    });
  });

  it("logs cron jobs and summarises state", async () => {
    const ledger = fresh();
    await ledger.cronLog("selftest", true, "ok", NOON);
    const s = await ledger.summary(3, NOON);
    expect(s.lastCron).toMatchObject({ job: "selftest", ok: true });
    expect(s.breakers.map((b) => b.state)).toEqual(["closed", "closed"]);
  });
});
