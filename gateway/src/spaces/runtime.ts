// Hugging Face Space runtime (Platform M3): read the stage; restart a sleeping/paused/stopped Space.
export type SpaceState =
  { state: "running" } | { state: "waking"; etaS: number } | { state: "error"; detail: string };

const SLEEPY = new Set(["SLEEPING", "PAUSED", "STOPPED"]);
const WAKE_ETA_S = 90;
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; stage: string }>();

export async function spaceStage(
  repo: string,
  token: string,
  doFetch: typeof fetch = fetch,
  now = Date.now(),
): Promise<string> {
  const hit = cache.get(repo);
  if (hit && now - hit.at < CACHE_MS) return hit.stage;
  const res = await doFetch(`https://huggingface.co/api/spaces/${repo}/runtime`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`HF runtime ${res.status}`);
  const { stage } = (await res.json()) as { stage: string };
  cache.set(repo, { at: now, stage });
  return stage;
}

/** Running → running; sleeping/paused/stopped → restart and report waking (~90 s); building → waking. */
export async function ensureAwake(
  repo: string,
  token: string,
  doFetch: typeof fetch = fetch,
  now = Date.now(),
): Promise<SpaceState> {
  try {
    const stage = await spaceStage(repo, token, doFetch, now);
    if (stage === "RUNNING") return { state: "running" };
    if (SLEEPY.has(stage)) {
      await doFetch(`https://huggingface.co/api/spaces/${repo}/restart`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      cache.delete(repo);
    }
    return { state: "waking", etaS: WAKE_ETA_S };
  } catch (e) {
    return { state: "error", detail: (e as Error).message };
  }
}

export const clearRuntimeCache = () => cache.clear();
