# aj-platform — shared AI gateway and demo site

The infrastructure behind my live AI demos, running entirely on Cloudflare's free plan (₹0). It is used by **[Satya](https://github.com/adityajajodia95/satya)**, a multi-agent fact-verification system — live at <https://aj-demos.pages.dev/satya/>.

## What is in it

| Part                    | What it does                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`gateway/`** (Worker) | One AI gateway for every demo: model routing with failover (Workers AI first, Groq second — the same model on both), one provider pinned per run, per-project daily budgets, per-visitor limits, circuit breakers, a result cache, Turnstile sessions, and a public status endpoint. Demos call it over service-binding RPC. |
| **`site/`** (Pages)     | The public site: routes `/api/<project>/*` to each project's API, serves each demo's web build under `/<project>/`, a system status page, and a strict Content-Security-Policy.                                                                                                                                              |
| **`scripts/`**          | Sets the Cloudflare secrets from generated random values (`wrangler secret put`), so no secret is ever typed into code or chat.                                                                                                                                                                                              |

## Why a shared gateway

Free tiers are small and providers fail. Putting budgets, limits, failover and caching in one place means every demo gets the same protection, the free quota is shared fairly between demos, and a run never mixes two models (the provider is pinned per run).

- **Budgets** live in a Durable Object (`LedgerDO`), so reservations and settlements are strongly consistent; each project has a daily share and a safety margin.
- **Per-visitor limits** count salted, daily hashes of the network address — raw addresses are never stored.
- **Circuit breakers** pause a failing provider for 5 minutes and re-check it on the next use.
- A **cron** every 6 hours self-tests Workers AI and records the result on the status page.

## Quality

41 tests run inside workerd (the Workers runtime): budgets under concurrency, daily resets, failover and pinning, JSON-schema validation with one repair attempt, breakers, sessions, the status page and the Space proxy. GitHub Actions run the checks on every push and deploy when the Cloudflare secrets are configured.

Build log and deviations: [PROGRESS.md](PROGRESS.md).

---

Built by **Aditya Jajodia** — M.Tech in Data Science and Machine Learning — <adityajajodia95@gmail.com>. Licence: MIT.
