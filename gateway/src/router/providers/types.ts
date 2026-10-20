import type { LlmRequest } from "../../types";

export interface ProviderReply {
  text: string;
  usage: { input: number; output: number };
  /** Workers AI reports neurons in `usage.neurons`. */
  neurons?: number;
  /** Groq `x-ratelimit-remaining-tokens`, when present. */
  remainingTokens?: number;
}

/** A provider failure. `retryable` covers 429/5xx/timeouts (Platform M2 step 5). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500 || this.status === 0;
  }
}

export type ProviderCall = (req: LlmRequest, model: string, signal: AbortSignal) => Promise<ProviderReply>;
