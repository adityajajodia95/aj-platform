import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Tests run inside workerd with the real wrangler.jsonc (Durable Objects, bindings); providers are faked.
export default defineConfig({
  // remoteBindings: false — unit tests never reach Cloudflare; the AI binding is replaced by fakes in each test.
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      remoteBindings: false,
      // Test-only secrets (Cloudflare documented always-pass Turnstile secret); real ones live in wrangler secrets.
      miniflare: {
        bindings: {
          TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
          SESSION_KEY: "test-session-key",
          ADMIN_TOKEN: "test-admin-token",
          GROQ_API_KEY: "test",
        },
      },
    }),
  ],
  test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.integration.test.ts"] },
});
