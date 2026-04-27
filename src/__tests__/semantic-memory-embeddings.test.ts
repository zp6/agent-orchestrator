import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore } from "../state/store.js";
import {
  createEmbeddingClient,
  resetEmbeddingClient,
} from "../client/llm-client.js";
import {
  findSimilarMemoryTopics,
  reindexSemanticMemory,
} from "../orchestrator/semantic-memory.js";

function makeTempStore() {
  const dir = mkdtempSync(join(tmpdir(), "agent-reviewer-semantic-"));
  const dbPath = join(dir, "state.db");
  const store = new StateStore(dbPath);
  return { store, dir };
}

function ensureTaskExists(store: StateStore, taskId: string): void {
  const db = (store as unknown as { db: { prepare: (s: string) => { run: (...a: unknown[]) => void } } }).db;
  db.prepare(
    `INSERT OR IGNORE INTO tasks
       (id, title, status, task_type, created_at, updated_at)
     VALUES (?, ?, 'done', 'implementation', datetime('now'), datetime('now'))`,
  ).run(taskId, `Task ${taskId}`);
}

function recordEntry(
  store: StateStore,
  topic: string,
  taskId: string,
  confidence: number,
  outcome: "success" | "failure" | "partial",
): void {
  ensureTaskExists(store, taskId);
  store.recordMemoryEntry(topic, taskId, confidence, outcome);
}

function mockJsonFetchOnce(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

describe("embedding client + semantic-memory reindex", () => {
  let store: StateStore;
  let dir: string;

  beforeEach(() => {
    ({ store, dir } = makeTempStore());
    resetEmbeddingClient();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetEmbeddingClient();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prefers Ollama for embeddings and returns local vectors", async () => {
    const fetchSpy = mockJsonFetchOnce({ embeddings: [[0.25, 0.75]] });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createEmbeddingClient({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
    });

    const result = await client.embed("hello world");

    expect(result.source).toBe("ollama");
    expect(result.fallbackUsed).toBe(false);
    expect(result.model).toBe("nomic-embed-text");
    expect(result.embeddings).toEqual([[0.25, 0.75]]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/embed");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "nomic-embed-text",
      input: "hello world",
    });
  });

  it("falls back to a cloud embedding endpoint when Ollama fails", async () => {
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ data: [{ embedding: [0.11, 0.22, 0.33] }] }),
        text: () => Promise.resolve(""),
      });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createEmbeddingClient({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
      fallback: {
        baseUrl: "https://embeddings.example.com",
        apiKey: "secret",
        model: "cloud-embed",
      },
    });

    const result = await client.embed(["topic one", "topic two"]);

    expect(result.source).toBe("cloud");
    expect(result.fallbackUsed).toBe(true);
    expect(result.model).toBe("cloud-embed");
    expect(result.embeddings).toEqual([[0.11, 0.22, 0.33]]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      authorization: "Bearer secret",
      "content-type": "application/json",
    });
  });

  it("reindexes semantic-memory topics into the embeddings table", async () => {
    recordEntry(store, "authentication", "task-001", 0.88, "success");
    recordEntry(store, "authentication", "task-002", 0.76, "partial");
    recordEntry(store, "rate-limiting", "task-003", 0.55, "failure");

    const fetchSpy = mockJsonFetchOnce({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.9, 0.8, 0.7],
      ],
    });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createEmbeddingClient({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
    });

    const report = await reindexSemanticMemory(store, { embeddingClient: client, batchSize: 8 });

    expect(report.total_topics).toBe(2);
    expect(report.embedded_topics).toBe(2);
    expect(report.skipped_topics).toBe(0);
    expect(report.embedding_source).toBe("ollama");
    expect(report.fallback_used).toBe(false);

    const rows = store.listMemoryTopicEmbeddings();
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.topic)).toEqual(["authentication", "rate-limiting"]);
    expect(rows[0]?.embedding_model).toBe("nomic-embed-text");
    expect(rows[0]?.embedding_source).toBe("ollama");
  });

  it("finds similar topics from stored embeddings", async () => {
    store.upsertMemoryTopicEmbedding("authentication", [1, 0, 0], "nomic-embed-text", "ollama");
    store.upsertMemoryTopicEmbedding("auth-refresh", [0.98, 0.02, 0], "nomic-embed-text", "ollama");
    store.upsertMemoryTopicEmbedding("billing", [0, 1, 0], "nomic-embed-text", "ollama");

    const fetchSpy = mockJsonFetchOnce({ embeddings: [[1, 0, 0]] });
    vi.stubGlobal("fetch", fetchSpy);

    const client = createEmbeddingClient({
      ollamaBaseUrl: "http://localhost:11434",
      ollamaModel: "nomic-embed-text",
    });

    const matches = await findSimilarMemoryTopics("auth", store, { embeddingClient: client, limit: 2, threshold: 0.5 });

    expect(matches).toHaveLength(2);
    expect(matches[0]?.topic).toBe("authentication");
    expect(matches[0]?.similarity).toBeCloseTo(1, 5);
    expect(matches[1]?.topic).toBe("auth-refresh");
    expect(matches[1]?.similarity).toBeGreaterThan(0.9);
  });
});
