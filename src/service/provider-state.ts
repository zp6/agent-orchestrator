import { createLogger } from "./logger.js";
import { notifyOperator } from "./notify.js";

const log = createLogger("provider-state");

interface ProviderState {
  exhausted: boolean;
  exhaustedSince: Date | null;
  resetAt: Date | null;
  lastError: string | null;
}

const states = new Map<string, ProviderState>();

function getState(provider: string): ProviderState {
  let state = states.get(provider);
  if (!state) {
    state = { exhausted: false, exhaustedSince: null, resetAt: null, lastError: null };
    states.set(provider, state);
  }
  return state;
}

/**
 * Mark a provider as rate-limited / exhausted.
 * All pool members using this provider will be skipped until recovery.
 */
export function markProviderExhausted(provider: string, error: string, resetAt?: Date): void {
  const state = getState(provider);
  if (state.exhausted) return; // already marked

  state.exhausted = true;
  state.exhaustedSince = new Date();
  state.resetAt = resetAt ?? null;
  state.lastError = error;

  const resetStr = resetAt ? ` Resets at ${resetAt.toISOString()}` : "";
  log.warn("Provider marked exhausted", { provider, error, resetAt: resetStr });

  notifyOperator(
    `Provider exhausted: ${provider}`,
    `${provider} hit rate limit: ${error}.${resetStr} Other providers continue working.`,
    "critical",
    `provider-exhausted:${provider}`,
  ).catch(() => {});
}

/**
 * Mark a provider as available again (e.g. after a successful call).
 */
export function markProviderAvailable(provider: string): void {
  const state = getState(provider);
  if (!state.exhausted) return;

  const downtime = state.exhaustedSince
    ? Math.round((Date.now() - state.exhaustedSince.getTime()) / 1000)
    : 0;

  state.exhausted = false;
  state.exhaustedSince = null;
  state.resetAt = null;
  state.lastError = null;

  log.info("Provider recovered", { provider, downtimeSeconds: downtime });

  notifyOperator(
    `Provider recovered: ${provider}`,
    `${provider} is back online after ${downtime}s downtime. Full fleet active.`,
    "info",
    `provider-recovered:${provider}`,
  ).catch(() => {});
}

/**
 * Check if a provider is currently available for work.
 * Auto-recovers if resetAt has passed.
 */
export function isProviderAvailable(provider: string): boolean {
  const state = getState(provider);
  if (!state.exhausted) return true;

  // Auto-recover if reset time has passed
  if (state.resetAt && new Date() >= state.resetAt) {
    markProviderAvailable(provider);
    return true;
  }

  return false;
}

/**
 * Detect if an error is a rate limit response.
 *
 * Covers both standard 429 rate limits and Anthropic's "extra usage" quota
 * exhaustion errors which arrive as HTTP 500 api_error responses with the
 * message "You're out of extra usage · resets Xpm (UTC)".  These must be
 * caught here so they are NOT mis-classified as connection errors (which
 * would waste retry attempts against an already-exhausted provider).
 */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("rate_limit") ||
    msg.includes("hit your limit") ||
    msg.includes("usage limit") ||
    msg.includes("quota") ||
    msg.includes("too many requests") ||
    msg.includes("overloaded") ||
    // Anthropic "extra usage" quota exhaustion (HTTP 500 api_error)
    // e.g. "You're out of extra usage · resets 1pm (UTC)"
    msg.includes("out of extra usage") ||
    msg.includes("extra usage") ||
    msg.includes("out of daily")
  );
}

/**
 * Try to extract a reset time from an error message.
 * Looks for patterns like "resets at 5pm", "retry after 60", "resets 1pm (UTC)", etc.
 */
export function parseResetTime(err: unknown): Date | null {
  const msg = err instanceof Error ? err.message : String(err);

  // "retry-after: 60" or "Retry-After: 60"
  const retryAfterMatch = msg.match(/retry[- ]after:?\s*(\d+)/i);
  if (retryAfterMatch) {
    return new Date(Date.now() + parseInt(retryAfterMatch[1], 10) * 1000);
  }

  // "try again at Apr 13th, 2026 10:21 PM" (Codex/OpenAI format)
  const dateMatch = msg.match(/try again at ([A-Z][a-z]+ \d+(?:st|nd|rd|th)?,?\s*\d{4}\s+\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (dateMatch) {
    try {
      // Strip ordinal suffixes (13th → 13) for Date.parse
      const cleaned = dateMatch[1].replace(/(\d+)(?:st|nd|rd|th)/i, "$1");
      const parsed = new Date(cleaned);
      if (!isNaN(parsed.getTime())) return parsed;
    } catch { /* fall through */ }
  }

  // Anthropic "extra usage" quota format: "resets 1pm (UTC)" or "resets 11:30am (UTC)"
  // Also handles: "resets at 1pm", "resets at 11:30am (UTC)"
  const resetsHourMatch = msg.match(/resets(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(utc\))?/i);
  if (resetsHourMatch) {
    let hours = parseInt(resetsHourMatch[1], 10);
    const minutes = parseInt(resetsHourMatch[2] ?? "0", 10);
    const ampm = resetsHourMatch[3].toLowerCase();
    if (ampm === "pm" && hours !== 12) hours += 12;
    if (ampm === "am" && hours === 12) hours = 0;

    const now = new Date();
    const resetAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0),
    );
    // If the reset time has already passed today (UTC), use tomorrow
    if (resetAt <= now) {
      resetAt.setUTCDate(resetAt.getUTCDate() + 1);
    }
    return resetAt;
  }

  // Fallback: assume 5 minute cooldown
  return new Date(Date.now() + 5 * 60 * 1000);
}

/**
 * Get status summary for all tracked providers (for Telegram stats).
 */
export function getProviderStates(): Map<string, { exhausted: boolean; exhaustedSince: Date | null; resetAt: Date | null }> {
  // Auto-recover expired states before returning
  for (const [provider, state] of states) {
    if (state.exhausted && state.resetAt && new Date() >= state.resetAt) {
      markProviderAvailable(provider);
    }
  }
  return new Map(
    [...states].map(([k, v]) => [k, { exhausted: v.exhausted, exhaustedSince: v.exhaustedSince, resetAt: v.resetAt }]),
  );
}
