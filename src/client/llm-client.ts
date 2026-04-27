/**
 * LLM and embedding clients used by the reviewer/orchestrator modules.
 *
 * The text-generation client remains Anthropic-backed because that is what the
 * reviewer already uses. Embeddings are handled separately: local Ollama is
 * tried first, and a configured cloud embedding endpoint is used as a failover
 * so semantic-memory jobs keep running when the laptop is offline or under
 * memory pressure.
 */

import Anthropic from "@anthropic-ai/sdk";

export interface EmbeddingClient {
  embed(input: string | string[]): Promise<EmbeddingBatchResult>;
}

export interface EmbeddingBatchResult {
  embeddings: number[][];
  source: "ollama" | "cloud";
  fallbackUsed: boolean;
  model: string;
}

export interface EmbeddingClientOptions {
  /** Local Ollama base URL, defaults to http://localhost:11434. */
  ollamaBaseUrl?: string;
  /** Ollama embedding model, defaults to nomic-embed-text. */
  ollamaModel?: string;
  /** Timeout in milliseconds for each HTTP request. */
  timeoutMs?: number;
  /** Optional cloud fallback embedding endpoint. */
  fallback?: {
    baseUrl: string;
    apiKey?: string;
    model: string;
  };
}

const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Wraps a system prompt string in a cache_control block so Anthropic's
 * prompt caching feature applies to it. On the first request the prompt is
 * computed normally; on subsequent requests with the same prompt the cached
 * version is used, saving ~80–90% of system-prompt input tokens.
 *
 * Usage:
 *   system: buildCachedSystemContent(MY_SYSTEM_PROMPT)
 */
export function buildCachedSystemContent(
  text: string,
): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

let _client: Anthropic | null = null;
let _embeddingClient: EmbeddingClient | null = null;

/**
 * Returns a shared Anthropic client instance.
 * Reads credentials from environment:
 *   ANTHROPIC_API_KEY  — required
 *   ANTHROPIC_BASE_URL — optional; overrides the default API endpoint
 */
export function createLLMClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY environment variable is required for the reviewer LLM client",
    );
  }

  const baseURL = process.env.ANTHROPIC_BASE_URL;
  _client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  return _client;
}

/** Reset the cached client (useful in tests). */
export function resetLLMClient(): void {
  _client = null;
}

function resolveEmbeddingOptions(
  opts: EmbeddingClientOptions = {},
): Required<Omit<EmbeddingClientOptions, "fallback">> & { fallback?: NonNullable<EmbeddingClientOptions["fallback"]> } {
  const ollamaBaseUrl = opts.ollamaBaseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_BASE_URL;
  const ollamaModel = opts.ollamaModel ?? process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_MODEL;
  const timeoutMs = opts.timeoutMs ?? Number(process.env.EMBEDDING_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

  const fallbackBaseUrl = opts.fallback?.baseUrl ?? process.env.EMBEDDING_FALLBACK_BASE_URL;
  const fallbackModel = opts.fallback?.model ?? process.env.EMBEDDING_FALLBACK_MODEL;
  const fallbackApiKey = opts.fallback?.apiKey ?? process.env.EMBEDDING_FALLBACK_API_KEY;

  const fallback = fallbackBaseUrl && fallbackModel
    ? { baseUrl: fallbackBaseUrl, model: fallbackModel, apiKey: fallbackApiKey }
    : undefined;

  return { ollamaBaseUrl, ollamaModel, timeoutMs, fallback };
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number, headers: Record<string, string> = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}${text ? `: ${text}` : ""}`);
    }

    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

function normaliseEmbeddingsResponse(value: unknown): number[][] {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid embedding response");
  }

  const record = value as Record<string, unknown>;
  if (Array.isArray(record.embeddings)) {
    return record.embeddings.map((embedding) => {
      if (!Array.isArray(embedding)) throw new Error("Invalid embeddings array");
      return embedding.map((entry) => {
        const n = Number(entry);
        if (!Number.isFinite(n)) throw new Error("Embedding contained a non-finite value");
        return n;
      });
    });
  }

  if (Array.isArray(record.data)) {
    return record.data.map((item) => {
      if (!item || typeof item !== "object" || !Array.isArray((item as Record<string, unknown>).embedding)) {
        throw new Error("Invalid OpenAI-compatible embeddings response");
      }
      return (item as { embedding: unknown[] }).embedding.map((entry) => {
        const n = Number(entry);
        if (!Number.isFinite(n)) throw new Error("Embedding contained a non-finite value");
        return n;
      });
    });
  }

  if (Array.isArray(record.embedding)) {
    return [record.embedding.map((entry) => {
      const n = Number(entry);
      if (!Number.isFinite(n)) throw new Error("Embedding contained a non-finite value");
      return n;
    })];
  }

  throw new Error("Unrecognised embedding response shape");
}

class OllamaEmbeddingClient implements EmbeddingClient {
  private readonly ollamaBaseUrl: string;
  private readonly ollamaModel: string;
  private readonly timeoutMs: number;
  private readonly fallback?: NonNullable<EmbeddingClientOptions["fallback"]>;

  constructor(opts: EmbeddingClientOptions = {}) {
    const resolved = resolveEmbeddingOptions(opts);
    this.ollamaBaseUrl = resolved.ollamaBaseUrl;
    this.ollamaModel = resolved.ollamaModel;
    this.timeoutMs = resolved.timeoutMs;
    this.fallback = resolved.fallback;
  }

  async embed(input: string | string[]): Promise<EmbeddingBatchResult> {
    const payload = { model: this.ollamaModel, input };

    try {
      const response = await postJson<unknown>(
        `${this.ollamaBaseUrl.replace(/\/$/, "")}/api/embed`,
        payload,
        this.timeoutMs,
      );
      return {
        embeddings: normaliseEmbeddingsResponse(response),
        source: "ollama",
        fallbackUsed: false,
        model: this.ollamaModel,
      };
    } catch (error) {
      if (!this.fallback) throw error;

      const fallbackResponse = await postJson<unknown>(
        `${this.fallback.baseUrl.replace(/\/$/, "")}/v1/embeddings`,
        { model: this.fallback.model, input },
        this.timeoutMs,
        this.fallback.apiKey ? { authorization: `Bearer ${this.fallback.apiKey}` } : {},
      );
      return {
        embeddings: normaliseEmbeddingsResponse(fallbackResponse),
        source: "cloud",
        fallbackUsed: true,
        model: this.fallback.model,
      };
    }
  }
}

/**
 * Returns a shared embedding client. Ollama is tried first and falls back to a
 * configured cloud embedding endpoint when available.
 */
export function createEmbeddingClient(opts: EmbeddingClientOptions = {}): EmbeddingClient {
  if (!_embeddingClient) {
    _embeddingClient = new OllamaEmbeddingClient(opts);
  }
  return _embeddingClient;
}

/** Reset the cached embedding client (useful in tests). */
export function resetEmbeddingClient(): void {
  _embeddingClient = null;
}
