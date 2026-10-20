// Groq (fallback, same model): OpenAI-compatible chat completions with strict JSON-schema output.
import { type ProviderCall, ProviderError } from "./types";

const URL = "https://api.groq.com/openai/v1/chat/completions";

/** Groq reset headers look like "6m24.5s", "12.3s" or "450ms". */
export function parseDurationMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber * 1000;
  let ms = 0;
  for (const [, n, unit] of value.matchAll(/([\d.]+)(ms|s|m|h)/g)) {
    ms += Number(n) * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
  }
  return ms || undefined;
}

export function groq(apiKey: string, doFetch: typeof fetch = fetch): ProviderCall {
  return async (req, model, signal) => {
    const body = {
      model,
      messages: req.messages,
      max_completion_tokens: req.maxTokens ?? 1024,
      ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      ...(req.seed === undefined ? {} : { seed: req.seed }),
      reasoning_effort: req.reasoning ?? "low",
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
    let res: Response;
    try {
      res = await doFetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new ProviderError(
        `groq: ${(e as Error).name === "AbortError" || (e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`,
        0,
      );
    }
    const remaining = Number(res.headers.get("x-ratelimit-remaining-tokens"));
    if (!res.ok) {
      const retryAfter =
        parseDurationMs(res.headers.get("retry-after")) ??
        parseDurationMs(res.headers.get("x-ratelimit-reset-tokens"));
      throw new ProviderError(
        `groq: ${res.status} ${(await res.text()).slice(0, 200)}`,
        res.status,
        retryAfter,
      );
    }
    const out = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: out.choices?.[0]?.message?.content ?? "",
      usage: { input: out.usage?.prompt_tokens ?? 0, output: out.usage?.completion_tokens ?? 0 },
      ...(Number.isFinite(remaining) && res.headers.has("x-ratelimit-remaining-tokens")
        ? { remainingTokens: remaining }
        : {}),
    };
  };
}
