/**
 * Semantic-memory embedding reindexing and similarity helpers.
 *
 * Ollama is the first-choice embedding backend. When it is unavailable, the
 * shared embedding client falls back to a configured cloud endpoint so the
 * daemon keeps running without blocking on local model outages.
 */

import { createLogger } from "../service/logger.js";
import { createEmbeddingClient } from "../client/llm-client.js";
import type {
  EmbeddingClient,
  EmbeddingBatchResult,
} from "../client/llm-client.js";
import type {
  ISemanticMemoryStore,
  SemanticMemoryEmbeddingSource,
  SemanticMemoryReindexReport,
  SemanticMemoryTopicEmbedding,
} from "../state/types.js";

const log = createLogger("semantic-memory");

export const FLAG_LAST_SEMANTIC_REINDEX = "semantic_memory_reindex_last_run";
export const DEFAULT_REINDEX_HOUR_UTC = 2;
export const DEFAULT_REINDEX_BATCH_SIZE = 32;
export const DEFAULT_SIMILARITY_THRESHOLD = 0.72;

export interface SemanticMemoryReindexOptions {
  embeddingClient?: EmbeddingClient;
  batchSize?: number;
}

export interface SemanticMemorySchedulerStore extends ISemanticMemoryStore {
  getSystemFlag(key: string): string | null;
  setSystemFlag(key: string, value: string): void;
}

export interface SemanticMemorySimilarityResult {
  topic: string;
  similarity: number;
  embedding_source: SemanticMemoryEmbeddingSource;
  embedded_at: string;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let aMagnitude = 0;
  let bMagnitude = 0;

  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    aMagnitude += av * av;
    bMagnitude += bv * bv;
  }

  if (aMagnitude === 0 || bMagnitude === 0) return 0;
  return dot / (Math.sqrt(aMagnitude) * Math.sqrt(bMagnitude));
}

function chunkTopics(topics: string[], batchSize: number): string[][] {
  if (batchSize <= 0) return [topics];
  const batches: string[][] = [];
  for (let i = 0; i < topics.length; i += batchSize) {
    batches.push(topics.slice(i, i + batchSize));
  }
  return batches;
}

function isSameTopicEmbedding(existing: SemanticMemoryTopicEmbedding | undefined, embedding: number[]): boolean {
  if (!existing) return false;
  try {
    const parsed = JSON.parse(existing.embedding_json) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== embedding.length) return false;
    return parsed.every((entry, index) => Number(entry) === embedding[index]);
  } catch {
    return false;
  }
}

/**
 * Reindex all semantic-memory topics using the current embedding backend.
 *
 * The job is intentionally tolerant of partial failure: a single topic failure
 * is logged and skipped, while the overall run still completes.
 */
export async function reindexSemanticMemory(
  store: ISemanticMemoryStore,
  opts: SemanticMemoryReindexOptions = {},
): Promise<SemanticMemoryReindexReport> {
  const startedAt = new Date().toISOString();
  const topics = store.listMemoryTopics();
  const embeddingClient = opts.embeddingClient ?? createEmbeddingClient();
  const batchSize = opts.batchSize ?? DEFAULT_REINDEX_BATCH_SIZE;
  const existing = new Map(store.listMemoryTopicEmbeddings().map((row) => [row.topic, row]));

  let embeddedTopics = 0;
  let skippedTopics = 0;
  let embeddingSource: SemanticMemoryEmbeddingSource = "ollama";
  let fallbackUsed = false;

  for (const batch of chunkTopics(topics, batchSize)) {
    if (batch.length === 0) continue;

    let result: EmbeddingBatchResult;
    try {
      result = await embeddingClient.embed(batch);
    } catch (error) {
      log.error("Failed to generate semantic-memory embeddings", {
        error: error instanceof Error ? error.message : String(error),
      });
      skippedTopics += batch.length;
      continue;
    }

    embeddingSource = result.source;
    fallbackUsed = fallbackUsed || result.fallbackUsed;

    for (let i = 0; i < batch.length; i++) {
      const topic = batch[i]!;
      const embedding = result.embeddings[i];
      if (!embedding) {
        skippedTopics += 1;
        continue;
      }

      const prior = existing.get(topic);
      if (isSameTopicEmbedding(prior, embedding)) {
        skippedTopics += 1;
        continue;
      }

      try {
        store.upsertMemoryTopicEmbedding(topic, embedding, result.model, result.source);
        embeddedTopics += 1;
      } catch (error) {
        log.error("Failed to persist semantic-memory embedding", {
          topic,
          error: error instanceof Error ? error.message : String(error),
        });
        skippedTopics += 1;
      }
    }
  }

  return {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_topics: topics.length,
    embedded_topics: embeddedTopics,
    skipped_topics: skippedTopics,
    embedding_source: embeddingSource,
    fallback_used: fallbackUsed,
  };
}

/**
 * Return the closest semantic-memory topics for an arbitrary query string.
 */
export async function findSimilarMemoryTopics(
  query: string,
  store: ISemanticMemoryStore & { listMemoryTopicEmbeddings(): SemanticMemoryTopicEmbedding[] },
  opts: { embeddingClient?: EmbeddingClient; limit?: number; threshold?: number } = {},
): Promise<SemanticMemorySimilarityResult[]> {
  const queryText = query.trim();
  if (!queryText) return [];

  const embeddingClient = opts.embeddingClient ?? createEmbeddingClient();
  const threshold = opts.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const limit = opts.limit ?? 5;
  const embeddings = store.listMemoryTopicEmbeddings();
  if (embeddings.length === 0) return [];

  const queryEmbeddingResult = await embeddingClient.embed(queryText);
  const queryEmbedding = queryEmbeddingResult.embeddings[0];
  if (!queryEmbedding) return [];

  const results = embeddings
    .map((row) => {
      try {
        const vector = JSON.parse(row.embedding_json) as unknown;
        if (!Array.isArray(vector)) return null;
        const parsed = vector.map((entry) => Number(entry));
        const similarity = cosineSimilarity(queryEmbedding, parsed);
        return {
          topic: row.topic,
          similarity,
          embedding_source: row.embedding_source,
          embedded_at: row.embedded_at,
        } satisfies SemanticMemorySimilarityResult;
      } catch {
        return null;
      }
    })
    .filter((row): row is SemanticMemorySimilarityResult => row !== null && row.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit);

  return results;
}

/**
 * Convenience scheduler for the daily reindex job.
 */
export class SemanticMemoryReindexScheduler {
  private readonly store: SemanticMemorySchedulerStore;
  private readonly embeddingClient: EmbeddingClient;
  private readonly reindexHourUtc: number;
  private readonly batchSize: number;

  constructor(
    store: SemanticMemorySchedulerStore,
    opts: SemanticMemoryReindexOptions & { reindexHourUtc?: number } = {},
  ) {
    this.store = store;
    this.embeddingClient = opts.embeddingClient ?? createEmbeddingClient();
    this.reindexHourUtc = opts.reindexHourUtc ?? DEFAULT_REINDEX_HOUR_UTC;
    this.batchSize = opts.batchSize ?? DEFAULT_REINDEX_BATCH_SIZE;
  }

  async maybeReindex(): Promise<SemanticMemoryReindexReport | null> {
    const now = new Date();
    if (now.getUTCHours() !== this.reindexHourUtc) return null;

    const todayUtc = now.toISOString().slice(0, 10);
    const lastRun = this.store.getSystemFlag(FLAG_LAST_SEMANTIC_REINDEX);
    if (lastRun && lastRun >= todayUtc) return null;

    try {
      const report = await reindexSemanticMemory(this.store, {
        embeddingClient: this.embeddingClient,
        batchSize: this.batchSize,
      });
      this.store.setSystemFlag(FLAG_LAST_SEMANTIC_REINDEX, todayUtc);
      return report;
    } catch (error) {
      log.error("Failed to reindex semantic memory", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
