// Workers AI (primary): gpt-oss-120b via the AI binding. The model answers in the OpenAI chat-completion
// shape and reports `usage.neurons` (verified by a live probe on 14 Oct 2026; see PROGRESS).
import type { LlmRequest } from "../../types";
import { type ProviderCall, ProviderError } from "./types";

interface ChatCompletion {
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; neurons?: number };
}

/** gpt-oss convention: reasoning effort in the system message, plus the documented `reasoning` parameter. */
export function withReasoning(req: LlmRequest): LlmRequest["messages"] {
  const effort = req.reasoning ?? "low";
  return [
    { role: "system", content: `Reasoning: ${effort}` },
    ...req.messages.filter((m) => m.role !== "system" || !m.content.startsWith("Reasoning:")),
  ];
}

export function workersAi(ai: Ai): ProviderCall {
  return async (req, model, signal) => {
    const input = {
      messages: withReasoning(req),
      max_tokens: req.maxTokens ?? 1024,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.seed === undefined ? {} : { seed: Math.max(1, req.seed) }),
      reasoning: { effort: req.reasoning ?? "low" },
      ...(req.jsonSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: req.task.replace(/\W/g, "_") || "output",
                schema: req.jsonSchema,
                strict: true,
              },
            },
          }
        : {}),
    };
    let out: ChatCompletion;
    try {
      const run = (ai as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(
        model,
        input,
      );
      out = (await abortable(run, signal)) as ChatCompletion;
    } catch (e) {
      throw toProviderError(e);
    }
    const text = out.choices?.[0]?.message?.content ?? "";
    return {
      text,
      usage: { input: out.usage?.prompt_tokens ?? 0, output: out.usage?.completion_tokens ?? 0 },
      ...(out.usage?.neurons === undefined ? {} : { neurons: out.usage.neurons }),
    };
  };
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new ProviderError("timeout", 0));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ProviderError("timeout", 0));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Workers AI errors carry an HTTP-ish code in the message; quota/limits and upstream errors are retryable. */
export function toProviderError(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const message = (e as Error)?.message ?? String(e);
  const status = /\b429\b|rate|limit|capacity|neurons|quota/i.test(message)
    ? 429
    : /\b4\d\d\b|invalid|bad input/i.test(message)
      ? 400
      : 503;
  return new ProviderError(`workersai: ${message.slice(0, 200)}`, status);
}
