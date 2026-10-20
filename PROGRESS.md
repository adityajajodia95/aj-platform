# aj-platform — Progress log

Source of truth: the private planning documents `docs/Platform_Architecture.md` and `docs/Platform_Development.md` (kept locally, not published). Scope agreed 13 Oct 2026 (C1, C9): Satya is the only enabled project; the website is not modified (M9 skipped, no custom domain — the public address is the `*.pages.dev` URL).

| Module                 | Status                   | Date       | Notes                                                                        |
| ---------------------- | ------------------------ | ---------- | ---------------------------------------------------------------------------- |
| M0 Bootstrap           | ✅ done                  | 2026-10-13 | `wrangler dev` works after `wrangler login`                                  |
| M1 LedgerDO            | ✅ done                  | 2026-10-13 | reserve/settle, safety margin, daily reset, per-IP limits, breakers, cache   |
| M2 Model router        | ✅ done                  | 2026-10-13 | Workers AI → Groq failover, run pinning, JSON validation + one repair        |
| M3 Space proxy         | ✅ done (not deployed)   | 2026-10-13 | tested against a fake Gradio server; no Spaces exist yet (C1)                |
| M4 Sessions            | ✅ done                  | 2026-10-13 | Turnstile → HttpOnly `aj_s` cookie; daily-salted IP hashes                   |
| M5 Status + cron       | ✅ done                  | 2026-10-13 | `/api/status` (30 s cache, CORS), cron every 6 h                             |
| M6 Pages site          | ✅ done                  | 2026-10-14 | https://aj-demos.pages.dev (custom domain skipped, C9); `/satya/` deep links |
| M7 aj-demo-kit         | ✅ done                  | 2026-10-14 | v1.0.0, v1.0.1 (accessible waking overlay); 12 tests                         |
| M8 CI/CD               | ✅ done                  | 2026-10-20 | repos public; CI green; deploys run once Cloudflare secrets are added        |
| M9 Website integration | skipped (owner decision) |            |                                                                              |
| M10 Hardening          | partial                  | 2026-10-14 | secret scan 0 hits; deployed checks in Satya QA_REPORT; chaos tests open     |

## M0 — Bootstrap (2026-10-13)

- npm workspaces `gateway`, `site`; TypeScript 6.0 strict, ESLint flat config, Prettier, Vitest 4 + `@cloudflare/vitest-plugin` 1.4.1 (renamed from `vitest-pool-workers`).
- `gateway/wrangler.jsonc`: `AI` binding, `LEDGER` → `LedgerDO` with `new_sqlite_classes` migration, cron `0 */6 * * *`, `nodejs_compat`, public vars `TURNSTILE_SITEKEY` (Cloudflare test key until the real widget exists) and `ENABLED_PROJECTS`. Config files copied verbatim from spec §4. Worker types from `wrangler types`.
- **Tested:** `vitest` (inside workerd, `remoteBindings: false` so unit tests never reach Cloudflare): 2 passed — `/api/status` placeholder, standard error body.
- **Blocked:** `wrangler dev` starts a remote proxy for the `AI` binding and needs `wrangler login`.

## M1–M7 (2026-10-13/14)

- **Gateway** (`aj-gateway` Worker, deployed): `Gateway` WorkerEntrypoint RPC (`llm`, `embed`, `rerank`, `space`, `hashIp`, `checkSession`, `consume`, `remaining`, `cacheGet`, `cachePut`) + fetch routes `/api/status`, `/api/session`, `/api/admin/llm`; `LedgerDO` (SQLite) for budgets, per-IP limits, breakers, cache and cron log. 41 tests (workerd, no remote bindings).
- **Site** (`aj-demos` Pages, deployed): landing, `/status/`, `functions/api/[[path]].ts` router (unknown/undeployed project → 503 `not_deployed`), strict CSP in `_headers`, `_redirects` rewrites for client-side routes of each demo, `scripts/assemble.mjs` (GitHub release asset or `--local slug=dir`).
- **aj-demo-kit** (tags v1.0.0, v1.0.1): `apiFetch`/`ApiError`, `usePlatformStatus`, `TurnstileGate`/`useSession`, `StatusPill`, `RunBadge`, `CapacityNotice`, `WakingOverlay`, `ProjectLinks`, `useGallery`.
- Secrets were set by the owner with `scripts/set-secrets.ps1` (`wrangler secret put`; nothing written to files except the gitignored `Satya/.env`).
- End-to-end evidence (deployed): see `Satya/QA_REPORT.md` — Turnstile 401, cache hit, real capacity → partial, Workers AI → Groq pinning, 132/132 UI tests.

## Deviations

| #   | Spec                                   | Implemented                                                                      | Why                                                     |
| --- | -------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------- |
| P1  | `@cloudflare/vitest-pool-workers`      | `@cloudflare/vitest-plugin`                                                      | package renamed/deprecated; same workerd runtime        |
| P2  | service bindings for all five projects | bindings only for deployed Workers (GATEWAY, SATYA); others → 503 `not_deployed` | C1; a binding to a missing Worker would fail the deploy |
| P3  | Ajv for JSON-schema validation         | `@cfworker/json-schema`                                                          | Ajv compiles with `new Function`, which Workers forbid  |
| P4  | `wrangler pages project create`        | `… --force`                                                                      | wrangler now steers Pages commands to Workers           |
| P5  | GitHub owner `adityajajodia`           | `adityajajodia95`                                                                | the owner's actual account                              |
| P6  | `_redirects` not in spec               | rewrites `/satya/<route>` → `/satya/` (200)                                      | deep links; a rewrite to `…/index.html` answers 308     |

## Publication (2026-10-20)

Public at <https://github.com/adityajajodia95/aj-platform> as a clean copy (the private planning documents in `docs/` are not published; the local history is unchanged). Both workflows ran green on the first push: checks pass, and the deploy steps skip with a notice until `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are added as repository secrets (optional — deploys from the laptop with `wrangler` keep working).
