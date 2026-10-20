// /api router (Platform M6): route by the first path segment to a service binding. The request is forwarded
// unchanged (method, headers incl. CF-Connecting-IP, body); responses get Cache-Control: no-store.
interface Env {
  GATEWAY: Fetcher;
  [binding: string]: Fetcher | undefined;
}

const PROJECT_BINDINGS: Record<string, string> = {
  satya: "SATYA",
  tarka: "TARKA",
  examlens: "EXAMLENS",
  "forget-me": "FORGETME",
  kaaran: "KAARAN",
};
const GATEWAY_ROUTES = new Set(["status", "session", "admin"]);

const error = (status: number, code: string, message: string) =>
  Response.json(
    { error: { code, message, retryAfterS: 0, fallback: code === "not_deployed" ? "gallery" : "none" } },
    { status, headers: { "Cache-Control": "no-store" } },
  );

export const onRequest: PagesFunction<Env> = async ({ request, env }) => {
  const segment = new URL(request.url).pathname.split("/")[2] ?? "";
  const target = GATEWAY_ROUTES.has(segment)
    ? env.GATEWAY
    : PROJECT_BINDINGS[segment]
      ? env[PROJECT_BINDINGS[segment]!]
      : undefined;
  if (!GATEWAY_ROUTES.has(segment) && !PROJECT_BINDINGS[segment])
    return error(404, "not_found", "No such API");
  if (!target) return error(503, "not_deployed", `The ${segment} demo is not deployed yet`);
  let res: Response;
  try {
    res = await target.fetch(request);
  } catch {
    return error(503, "not_deployed", `The ${segment} service is unavailable`);
  }
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-store");
  return out;
};
