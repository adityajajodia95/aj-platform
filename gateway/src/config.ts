// Free-tier numbers live only in config/*.json (re-verify before each deploy; Architecture §9).
import limits from "../config/limits.json";
import models from "../config/models.json";
import prices from "../config/prices.json";
import spaces from "../config/spaces.json";

export type Limits = typeof limits;
export const LIMITS: Limits = limits;
export const MODELS = models;
export const PRICES: Record<string, { in: number; out?: number }> = prices;
export const SPACES: Record<string, { repo: string; url: string }> = spaces;

/** ≈ chars / 3.6 (Platform M2 step 2). */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 3.6);

export function neuronsFor(model: string, input: number, output = 0): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  return (input * p.in + output * (p.out ?? 0)) / 1_000_000;
}

/** Minutes past 00:00 UTC for an "HH:MM" string. */
export const minutesOf = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export function inEvalWindow(now: number): { open: boolean; opensInS: number } {
  const d = new Date(now);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const [from, to] = LIMITS.evalWindowUtc.map(minutesOf) as [number, number];
  if (minute >= from && minute < to) return { open: true, opensInS: 0 };
  const wait = minute < from ? from - minute : 24 * 60 - minute + from;
  return { open: false, opensInS: wait * 60 - d.getUTCSeconds() };
}
