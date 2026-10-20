// Gradio REST client for ZeroGPU Spaces (Platform M3). Paths per the Gradio 5 HTTP API:
//   POST {url}/gradio_api/upload (multipart) → ["<server path>", …]
//   POST {url}/gradio_api/call/{api} {data:[…]} → {event_id}
//   GET  {url}/gradio_api/call/{api}/{event_id} → SSE: event: generating | complete | error, data: …
import { GatewayError } from "../types";

export interface SseEvent {
  event: string;
  data: string;
}

/** Splits an SSE body into events (blank-line separated; `data:` lines joined with "\n"). */
export function parseSse(body: string): SseEvent[] {
  return body
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      return { event, data: data.join("\n") };
    })
    .filter((e) => e.data !== "" || e.event !== "message");
}

/** ZeroGPU and queue failures → gateway error codes (fallback to the gallery + "open on Hugging Face"). */
export function mapGradioError(text: string, spaceUrl: string): GatewayError {
  if (/exceeded your (gpu )?quota|gpu quota|zerogpu/i.test(text)) {
    return new GatewayError(
      "capacity_exhausted",
      `ZeroGPU quota used; run it on Hugging Face: ${spaceUrl}`,
      0,
    );
  }
  if (/queue (is )?full|timed? ?out|timeout/i.test(text))
    return new GatewayError("timeout", text.slice(0, 200));
  if (/not running|sleeping|paused|building|starting/i.test(text))
    return new GatewayError("waking", text.slice(0, 200), 90);
  return new GatewayError("provider_down", text.slice(0, 200));
}

export async function uploadFiles(
  url: string,
  token: string,
  files: { name: string; bytes: ArrayBuffer }[],
  doFetch: typeof fetch = fetch,
): Promise<string[]> {
  const form = new FormData();
  for (const f of files) form.append("files", new Blob([f.bytes]), f.name);
  const res = await doFetch(`${url}/gradio_api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw mapGradioError(`upload ${res.status} ${await res.text()}`, url);
  return (await res.json()) as string[];
}

/** Starts a call and returns the SSE response of its event stream. */
export async function callSpace(
  url: string,
  token: string,
  api: string,
  data: unknown[],
  doFetch: typeof fetch = fetch,
  timeoutMs = 120_000,
): Promise<Response> {
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const start = await doFetch(`${url}/gradio_api/call/${api}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!start.ok) throw mapGradioError(`call ${start.status} ${await start.text()}`, url);
  const { event_id } = (await start.json()) as { event_id: string };
  const stream = await doFetch(`${url}/gradio_api/call/${api}/${event_id}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!stream.ok) throw mapGradioError(`stream ${stream.status}`, url);
  return stream;
}

/** Non-streaming result: the `complete` event's data (JSON), or a mapped error. */
export async function collectResult(stream: Response, spaceUrl: string): Promise<unknown> {
  const events = parseSse(await stream.text());
  const error = events.find((e) => e.event === "error");
  if (error) throw mapGradioError(error.data || "error", spaceUrl);
  const complete = events.find((e) => e.event === "complete");
  if (!complete) throw new GatewayError("timeout", "Space stream ended without a result");
  return JSON.parse(complete.data);
}

/** Re-emits Gradio SSE as our SSE: event: token | done | error (Platform M3 streaming). */
export function reemit(stream: Response, spaceUrl: string): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const e of parseSse(parts.join("\n\n"))) {
        const out =
          e.event === "generating"
            ? ["token", e.data]
            : e.event === "complete"
              ? ["done", e.data]
              : e.event === "error"
                ? ["error", mapGradioError(e.data, spaceUrl).message]
                : null;
        if (out) controller.enqueue(encoder.encode(`event: ${out[0]}\ndata: ${out[1]}\n\n`));
      }
    },
  });
  return new Response(stream.body?.pipeThrough(transform), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
  });
}
