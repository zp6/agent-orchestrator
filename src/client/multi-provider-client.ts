/**
 * Multi-provider LLM client for the reviewer pool.
 *
 * Supports Anthropic (default) and OpenAI-API-compatible providers:
 *   - Deepseek (base URL: https://api.deepseek.com/v1)
 *   - Grok / xAI (base URL: https://api.x.ai/v1)
 *
 * Environment variables:
 *   REVIEWER_PROVIDER  — "anthropic" | "deepseek" | "grok" (default: "anthropic")
 *   REVIEWER_MODEL     — model name override (defaults per provider below)
 *   DEEPSEEK_API_KEY   — required when REVIEWER_PROVIDER=deepseek
 *   DEEPSEEK_BASE_URL  — optional override (default: https://api.deepseek.com/v1)
 *   XAI_API_KEY        — required when REVIEWER_PROVIDER=grok
 *   XAI_BASE_URL       — optional override (default: https://api.x.ai/v1)
 *
 * The IReviewerLLMClient interface mirrors the subset of the Anthropic SDK
 * used by pr-reviewer, verifier, supervisor, and improvement-detector so
 * OpenAI-compatible providers can be swapped in without modifying call sites.
 *
 * Issue: rapartlu/agent-orchestrator#1211 (multi-provider expansion).
 */

import Anthropic from "@anthropic-ai/sdk";

// ── Provider types ─────────────────────────────────────────────────────────

export type ReviewerProvider = "anthropic" | "deepseek" | "grok";

/** Default models per provider (used when REVIEWER_MODEL is not set). */
const DEFAULT_MODELS: Record<ReviewerProvider, string> = {
  anthropic: "claude-sonnet-4-6",
  deepseek: "deepseek-reasoner",
  grok: "grok-4",
};

const DEFAULT_BASE_URLS: Record<Exclude<ReviewerProvider, "anthropic">, string> =
  {
    deepseek: "https://api.deepseek.com/v1",
    grok: "https://api.x.ai/v1",
  };

// ── Shared response shape ──────────────────────────────────────────────────

/**
 * Minimal Anthropic-compatible response interface.
 * Covers all fields accessed in pr-reviewer, verifier, supervisor, and
 * improvement-detector.
 */
export interface LLMMessageContent {
  type: "text";
  text: string;
}

export interface LLMUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface LLMMessageResponse {
  content: LLMMessageContent[];
  model: string;
  stop_reason: string | null;
  usage: LLMUsage;
}

// ── Create parameters ──────────────────────────────────────────────────────

export interface LLMCreateParams {
  model: string;
  max_tokens: number;
  /** System prompt — accepts the same format as Anthropic SDK (TextBlockParam[]) */
  system?: Anthropic.TextBlockParam[] | string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  temperature?: number;
}

// ── Client interface ───────────────────────────────────────────────────────

export interface IReviewerLLMClient {
  readonly provider: ReviewerProvider;
  readonly defaultModel: string;
  messages: {
    create(params: LLMCreateParams): Promise<LLMMessageResponse>;
  };
}

// ── Anthropic adapter ──────────────────────────────────────────────────────

class AnthropicLLMClient implements IReviewerLLMClient {
  readonly provider: ReviewerProvider = "anthropic";
  readonly defaultModel: string;
  private _sdk: Anthropic;

  messages: IReviewerLLMClient["messages"];

  constructor(sdk: Anthropic, model: string) {
    this._sdk = sdk;
    this.defaultModel = model;
    this.messages = {
      create: async (params: LLMCreateParams): Promise<LLMMessageResponse> => {
        const response = await this._sdk.messages.create({
          model: params.model,
          max_tokens: params.max_tokens,
          ...(params.system !== undefined ? { system: params.system as Anthropic.TextBlockParam[] } : {}),
          messages: params.messages as Anthropic.MessageParam[],
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
        });
        return {
          content: response.content
            .filter((c): c is Anthropic.TextBlock => c.type === "text")
            .map((c) => ({ type: "text" as const, text: c.text })),
          model: response.model,
          stop_reason: response.stop_reason,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            cache_read_input_tokens:
              (response.usage as unknown as Record<string, number>).cache_read_input_tokens ?? 0,
            cache_creation_input_tokens:
              (response.usage as unknown as Record<string, number>).cache_creation_input_tokens ?? 0,
          },
        };
      },
    };
  }
}

// ── OpenAI-compatible adapter (Deepseek, Grok) ────────────────────────────

interface OpenAIChoice {
  message: { role: string; content: string | null };
  finish_reason: string;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  model: string;
  usage: { prompt_tokens: number; completion_tokens: number };
}

class OpenAICompatLLMClient implements IReviewerLLMClient {
  readonly provider: ReviewerProvider;
  readonly defaultModel: string;
  private _baseUrl: string;
  private _apiKey: string;

  messages: IReviewerLLMClient["messages"];

  constructor(
    provider: ReviewerProvider,
    baseUrl: string,
    apiKey: string,
    model: string,
  ) {
    this.provider = provider;
    this._baseUrl = baseUrl.replace(/\/$/, "");
    this._apiKey = apiKey;
    this.defaultModel = model;

    this.messages = {
      create: async (params: LLMCreateParams): Promise<LLMMessageResponse> => {
        // Convert system param to a plain string for OpenAI-format APIs.
        let systemText = "";
        if (typeof params.system === "string") {
          systemText = params.system;
        } else if (Array.isArray(params.system) && params.system.length > 0) {
          systemText = params.system.map((b) => b.text).join("\n");
        }

        const openaiMessages: Array<{ role: string; content: string }> = [];
        if (systemText) {
          openaiMessages.push({ role: "system", content: systemText });
        }
        for (const msg of params.messages) {
          openaiMessages.push({ role: msg.role, content: msg.content });
        }

        const body = {
          model: params.model,
          max_tokens: params.max_tokens,
          messages: openaiMessages,
          ...(params.temperature !== undefined
            ? { temperature: params.temperature }
            : {}),
        };

        const res = await fetch(`${this._baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this._apiKey}`,
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "(no body)");
          throw new Error(
            `${provider} API error ${res.status}: ${errText}`,
          );
        }

        const json = (await res.json()) as OpenAIResponse;
        const choice = json.choices?.[0];
        const text = choice?.message?.content ?? "";

        return {
          content: [{ type: "text" as const, text }],
          model: json.model ?? params.model,
          stop_reason: choice?.finish_reason ?? null,
          usage: {
            input_tokens: json.usage?.prompt_tokens ?? 0,
            output_tokens: json.usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  }
}

// ── Provider resolution ────────────────────────────────────────────────────

/** Read and validate the active reviewer provider from the environment. */
export function getReviewerProvider(): ReviewerProvider {
  const raw = (process.env.REVIEWER_PROVIDER ?? "anthropic").toLowerCase();
  if (raw !== "anthropic" && raw !== "deepseek" && raw !== "grok") {
    throw new Error(
      `Unknown REVIEWER_PROVIDER "${raw}". Must be one of: anthropic, deepseek, grok`,
    );
  }
  return raw as ReviewerProvider;
}

/** Read the active reviewer model, falling back to the provider default. */
export function getReviewerModel(provider?: ReviewerProvider): string {
  if (process.env.REVIEWER_MODEL) return process.env.REVIEWER_MODEL;
  return DEFAULT_MODELS[provider ?? getReviewerProvider()];
}

// ── Factory ────────────────────────────────────────────────────────────────

let _poolClient: IReviewerLLMClient | null = null;

/**
 * Returns a shared IReviewerLLMClient instance chosen based on the active
 * REVIEWER_PROVIDER environment variable.
 *
 * Anthropic is the default. When REVIEWER_PROVIDER=deepseek (or grok), an
 * OpenAI-compatible client is returned that routes to the provider's API with
 * the matching API key.
 *
 * The returned client's `.messages.create()` method accepts the same
 * parameter shape as the Anthropic SDK so existing call sites work unchanged.
 */
export function createPoolAwareLLMClient(): IReviewerLLMClient {
  if (_poolClient) return _poolClient;

  const provider = getReviewerProvider();
  const model = getReviewerModel(provider);

  if (provider === "anthropic") {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is required when REVIEWER_PROVIDER=anthropic",
      );
    }
    const baseURL = process.env.ANTHROPIC_BASE_URL;
    const sdk = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
    _poolClient = new AnthropicLLMClient(sdk, model);
    return _poolClient;
  }

  // OpenAI-compatible provider (deepseek or grok)
  const envKeyMap: Record<Exclude<ReviewerProvider, "anthropic">, string> = {
    deepseek: "DEEPSEEK_API_KEY",
    grok: "XAI_API_KEY",
  };
  const envBaseUrlMap: Record<Exclude<ReviewerProvider, "anthropic">, string> = {
    deepseek: "DEEPSEEK_BASE_URL",
    grok: "XAI_BASE_URL",
  };

  const apiKeyEnv = envKeyMap[provider];
  const apiKey = process.env[apiKeyEnv];
  if (!apiKey) {
    throw new Error(
      `${apiKeyEnv} environment variable is required when REVIEWER_PROVIDER=${provider}`,
    );
  }

  const baseUrlEnv = envBaseUrlMap[provider];
  const baseUrl = process.env[baseUrlEnv] ?? DEFAULT_BASE_URLS[provider];

  _poolClient = new OpenAICompatLLMClient(provider, baseUrl, apiKey, model);
  return _poolClient;
}

/** Reset the cached pool client (useful in tests). */
export function resetPoolClient(): void {
  _poolClient = null;
}
