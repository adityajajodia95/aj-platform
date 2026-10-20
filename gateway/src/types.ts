// Gateway contracts (Platform_Development.md §3.1).
export type Project = "satya" | "tarka" | "examlens" | "forgetme" | "kaaran";
export const PROJECTS: readonly Project[] = ["satya", "tarka", "examlens", "forgetme", "kaaran"];
export type Provider = "workersai" | "groq";
export type Msg = { role: "system" | "user" | "assistant"; content: string };

export interface LlmRequest {
  project: Project;
  task: string;
  messages: Msg[];
  jsonSchema?: object;
  reasoning?: "low" | "medium" | "high";
  maxTokens?: number;
  temperature?: number;
  seed?: number;
  pin?: { provider: Provider };
  cacheKey?: string;
  budgetClass?: "demo" | "eval";
}

export interface LlmResult {
  text: string;
  json?: unknown;
  provider: Provider;
  model: string;
  usage: { input: number; output: number };
  neurons?: number;
  latencyMs: number;
  cached: boolean;
}

export type GatewayErrorCode =
  | "capacity_exhausted"
  | "rate_limited"
  | "provider_down"
  | "bad_output"
  | "timeout"
  | "bad_request"
  | "waking";

/**
 * Thrown by the gateway. Workers RPC keeps only `message` across the boundary, so the code and
 * retry hint are encoded in it ("gateway:<code>:<retryAfterS>:<text>"); callers use `parseGatewayError`.
 */
export class GatewayError extends Error {
  constructor(
    readonly code: GatewayErrorCode,
    text: string,
    readonly retryAfterS = 0,
  ) {
    super(`gateway:${code}:${Math.max(0, Math.round(retryAfterS))}:${text}`);
    this.name = "GatewayError";
  }
}

export function parseGatewayError(
  e: unknown,
): { code: GatewayErrorCode; retryAfterS: number; message: string } | null {
  const m = String((e as Error)?.message ?? e).match(/gateway:([a-z_]+):(\d+):([\s\S]*)/);
  return m ? { code: m[1] as GatewayErrorCode, retryAfterS: Number(m[2]), message: m[3] as string } : null;
}

/** Seconds until 00:00 UTC (when the free daily quotas reset; 05:30 IST). */
export function secondsUntilUtcMidnight(now: number): number {
  const d = new Date(now);
  return Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000);
}

export const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
