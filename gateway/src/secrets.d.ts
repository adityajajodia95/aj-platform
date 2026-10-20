// Worker secrets (set with `wrangler secret put`, never in config or code). Typed here because
// `wrangler types` only sees vars and bindings. Both the global Env and Cloudflare.Env (used by
// `cloudflare:test`) are augmented.
interface WorkerSecrets {
  ADMIN_TOKEN: string;
  GROQ_API_KEY: string;
  TURNSTILE_SECRET: string;
  SESSION_KEY: string;
  HF_TOKEN?: string;
}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
interface Env extends WorkerSecrets {}
declare namespace Cloudflare {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration merging
  interface Env extends WorkerSecrets {}
}
