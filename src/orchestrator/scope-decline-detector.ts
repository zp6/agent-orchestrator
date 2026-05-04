/**
 * Scope-decline detector (issue #1433).
 *
 * Parses an agent's response text for explicit signals that the agent has
 * declined a task on scope grounds — i.e., the task does not belong to
 * this agent's repo / capability surface — as opposed to declining for
 * quality, technical, or instruction-clarity reasons.
 *
 * The dispatcher uses this to short-circuit the normal 3-failure reroute
 * threshold to 1 when an agent has explicitly cited scope. A scope decline
 * is not a transient error: retrying against the same agent will produce
 * the same decline, wasting dispatch budget. The correct response is to
 * route the task to a different agent immediately.
 *
 * Design constraints:
 * - **Conservative.** False positives are worse than false negatives —
 *   an incorrect scope-decline detection would cause a healthy task to be
 *   incorrectly rerouted. We require a strong signal phrase, not a bare
 *   keyword like "scope".
 * - **Anchored.** Patterns are matched as phrases or against line / paragraph
 *   anchors so that incidental uses of "scope" in unrelated contexts (e.g.
 *   "scope creep", "in scope of this PR") do not trigger.
 * - **Auditable.** When a decline is detected, the matched signal phrase is
 *   returned so it can be persisted on the supervisor_decision row for later
 *   review and pattern analysis.
 */

/**
 * Result of running the detector against agent response text.
 *
 * `declined: true` means the agent has explicitly indicated the task is
 * out of scope for it. `signal` is the matched phrase that triggered the
 * detection (for audit logs and supervisor decision metadata).
 */
export interface ScopeDeclineResult {
  declined: boolean;
  /** The matched phrase that triggered the detection (if `declined`). */
  signal?: string;
}

/**
 * High-confidence scope-decline phrases. These are matched case-insensitively
 * with word boundaries where applicable. Each entry should be specific enough
 * that it cannot reasonably appear in benign content from a working agent.
 *
 * Ordering matters only for the `signal` returned: the first match wins.
 */
// Patterns are ordered most-specific → least-specific so the returned
// `signal` label reflects the strongest available evidence. The first
// match wins.
const HIGH_CONFIDENCE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Citation of CLAUDE.md alongside scope rules — bidirectional within 80
  // chars, so either order ("CLAUDE.md ... out of scope" or "out of scope
  // ... CLAUDE.md") triggers the match. Checked BEFORE bare "out of scope"
  // so the more specific signal wins.
  {
    pattern: /(?:CLAUDE\.md.{0,80}(?:out\s+of\s+scope|not\s+in\s+scope|scope\s+(?:section|list|rules?))|(?:out\s+of\s+scope|not\s+in\s+scope|scope\s+(?:section|list|rules?)).{0,80}CLAUDE\.md)/i,
    label: "claude-md-scope-citation",
  },
  // Direct refusal: "declining this task/dispatch/issue/PR/work" or
  // "I am declining" / "I'm declining" anywhere in the response, or
  // "Declining:" / "Decline:" / "Declined:" at the start of a paragraph.
  // Bare "declining" alone is intentionally NOT matched to avoid false
  // positives on phrases like "after declining a previous proposal".
  {
    pattern: /\b(?:i'?m\s+declining|i\s+am\s+declining|declining\s+(?:this|the)\s+(?:task|dispatch|issue|PR|work))\b|(?:^|\n)\s*(?:declining|decline|declined):/i,
    label: "explicit-decline-verb",
  },
  // Bare "out of scope" / "not in scope" / "outside ... scope" — covers
  // both copular form ("this is out of scope") and bare noun-phrase form
  // ("the 'out of scope' section"). Benign-context guard suppresses
  // incidental uses like "scope creep" or "in scope of this PR" in the
  // same paragraph.
  {
    pattern: /\b(?:out\s+of\s+scope|not\s+in\s+scope|outside\s+(?:my|this\s+agent's|this\s+repo's)\s+scope)\b/i,
    label: "out-of-scope-declaration",
  },
  // "Belongs in <other repo/agent>" — accepts both "belong" and "belongs"
  // because agents sometimes use the informal singular form.
  {
    pattern: /\b(?:belongs?|should\s+(?:live|be|go|reside))\s+in\s+(?:the\s+)?(?:runtime|dashboard|proxy|agent[-\s]?\w+|\w+[-/]\w+|\w+)\s+(?:repo|repository|package|agent)\b/i,
    label: "belongs-in-other-repo",
  },
  // "Not for this agent / repo / package"
  {
    pattern: /\b(?:this\s+(?:task|issue|work|PR))\s+(?:is\s+)?(?:not\s+(?:for|owned\s+by)|doesn'?t\s+belong\s+to)\s+(?:this\s+)?(?:agent|repo|repository|package)\b/i,
    label: "not-for-this-agent",
  },
  // "Wrong agent / repo / routing"
  {
    pattern: /\b(?:wrong|incorrect|misrouted)\s+(?:agent|repo|repository|routing|destination)\b/i,
    label: "wrong-routing-claim",
  },
];

/**
 * Phrases that look like scope-decline signals but are actually benign in
 * context. Used as a negative-match guard against false positives.
 *
 * If any of these appear *near* a high-confidence match, we suppress the
 * match — the agent is talking about scope, not declining on it.
 */
const BENIGN_CONTEXT_PATTERNS: RegExp[] = [
  /\bscope\s+creep\b/i,
  /\bin\s+scope\s+of\s+(?:this|the)\s+(?:PR|pull\s+request|issue|task)\b/i,
  /\bscope\s+of\s+work\b/i,
  /\b(?:project|task|PR|change)\s+scope\b/i,
];

/**
 * Returns true if the given text contains a benign use of scope-related
 * vocabulary near the matched span — used to suppress a high-confidence
 * match if the surrounding context indicates the agent is discussing
 * scope rather than declining on it.
 *
 * The check looks at the matching paragraph (split by blank lines) so that
 * a scope-creep mention three paragraphs away does not suppress a real
 * decline.
 */
function hasBenignContextNear(text: string, matchIndex: number): boolean {
  // Find paragraph boundaries (blank line on either side of the match)
  const before = text.lastIndexOf("\n\n", matchIndex);
  const after = text.indexOf("\n\n", matchIndex);
  const start = before === -1 ? 0 : before;
  const end = after === -1 ? text.length : after;
  const paragraph = text.slice(start, end);

  for (const benign of BENIGN_CONTEXT_PATTERNS) {
    if (benign.test(paragraph)) {
      return true;
    }
  }
  return false;
}

/**
 * Detect whether an agent's response text is an explicit scope decline.
 *
 * Returns `{ declined: false }` for empty / null input or when no
 * high-confidence pattern matches outside benign context.
 *
 * @param result The agent's final response text (Task.result).
 */
export function detectScopeDecline(
  result: string | null | undefined,
): ScopeDeclineResult {
  if (!result || typeof result !== "string") {
    return { declined: false };
  }
  // Skip very short responses — declines need at least a sentence of context
  // to be reliably detected, and short responses are rarely scope-related.
  if (result.length < 20) {
    return { declined: false };
  }

  for (const { pattern, label } of HIGH_CONFIDENCE_PATTERNS) {
    const match = pattern.exec(result);
    if (!match) continue;

    // Suppress if the match is in benign context
    if (hasBenignContextNear(result, match.index)) {
      continue;
    }

    return {
      declined: true,
      signal: label,
    };
  }

  return { declined: false };
}
