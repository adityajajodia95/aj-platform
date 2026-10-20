// Embeddings (bge-m3) and re-ranking (bge-reranker-base): Workers AI only, batched (≤ 64 texts), counted
// against the "embeddings" budget.
import { LIMITS, MODELS, estimateTokens, neuronsFor } from "../config";
import type { LedgerDO } from "../ledger";
import { GatewayError, secondsUntilUtcMidnight } from "../types";
import { abortable, toProviderError } from "./providers/workersai";

const BATCH = 64;
const BUDGET = "embeddings";

type Run = (model: string, input: unknown) => Promise<unknown>;

async function reserveEmbeddings(ledger: DurableObjectStub<LedgerDO>, neurons: number, now: number) {
  const r = await ledger.reserve({
    project: BUDGET,
    pool: "neurons",
    amount: neurons,
    need: neurons * (1 + LIMITS.safetyMargin),
    cap: LIMITS.budgets.embeddings,
    now,
  });
  if (!r.ok)
    throw new GatewayError(
      "capacity_exhausted",
      "today's embedding capacity is used",
      secondsUntilUtcMidnight(now),
    );
}

export async function embedTexts(
  ai: Ai,
  ledger: DurableObjectStub<LedgerDO>,
  texts: string[],
  now = Date.now(),
): Promise<number[][]> {
  const model = MODELS.embed.workersai;
  const est = neuronsFor(model, estimateTokens(texts.join("\n")));
  await reserveEmbeddings(ledger, est, now);
  const run = (ai as unknown as { run: Run }).run.bind(ai);
  const out: number[][] = [];
  try {
    for (let i = 0; i < texts.length; i += BATCH) {
      const res = (await abortable(
        run(model, { text: texts.slice(i, i + BATCH) }),
        AbortSignal.timeout(LIMITS.timeouts.embedMs),
      )) as { data: number[][] };
      out.push(...res.data);
    }
  } catch (e) {
    await ledger.settle({ project: BUDGET, pool: "neurons", reserved: est, actual: 0, now });
    throw new GatewayError("provider_down", toProviderError(e).message);
  }
  return out; // bge-m3 reports no usage; the token-based estimate stays as the accounted cost
}

/**
 * Scores in input order. Workers AI returns sigmoid probabilities; they are converted to logits so callers
 * see the same scale as the laptop's ONNX cross-encoder (Satya computes sigmoid(max re-rank logit)).
 */
export async function rerankPassages(
  ai: Ai,
  ledger: DurableObjectStub<LedgerDO>,
  query: string,
  passages: string[],
  now = Date.now(),
): Promise<number[]> {
  if (passages.length === 0) return [];
  const model = MODELS.rerank.workersai;
  const est = neuronsFor(
    model,
    estimateTokens(query) * passages.length + estimateTokens(passages.join("\n")),
  );
  await reserveEmbeddings(ledger, est, now);
  const run = (ai as unknown as { run: Run }).run.bind(ai);
  try {
    const scores = new Array<number>(passages.length).fill(-Infinity);
    let neurons = 0;
    for (let i = 0; i < passages.length; i += BATCH) {
      const batch = passages.slice(i, i + BATCH);
      const res = (await abortable(
        run(model, { query, contexts: batch.map((text) => ({ text })) }),
        AbortSignal.timeout(LIMITS.timeouts.embedMs),
      )) as {
        response: { id: number; score: number }[];
        usage?: { neurons?: number };
      };
      for (const r of res.response) scores[i + r.id] = toLogit(r.score);
      neurons += res.usage?.neurons ?? 0;
    }
    await ledger.settle({ project: BUDGET, pool: "neurons", reserved: est, actual: neurons || est, now });
    return scores;
  } catch (e) {
    await ledger.settle({ project: BUDGET, pool: "neurons", reserved: est, actual: 0, now });
    throw new GatewayError("provider_down", toProviderError(e).message);
  }
}

/** logit(p) = ln(p / (1 − p)), clamped so p ∈ {0, 1} stays finite. */
export function toLogit(p: number): number {
  const q = Math.min(1 - 1e-7, Math.max(1e-7, p));
  return Math.log(q / (1 - q));
}
