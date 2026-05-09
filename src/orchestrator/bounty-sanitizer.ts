/**
 * Prompt-injection sanitizer for external bounty content (issue #1553).
 *
 * Pre-#1273 implementation: detects the most dangerous known patterns — HTML
 * comment injection (the `1712n/dn-institute` honeypot technique) and common
 * bidirectional/hidden-text tricks. When #1273 ships its full sanitizer this
 * module is the call-site; callers don't change.
 *
 * Policy: conservative allowlist — if the content raises *any* flag it is
 * quarantined. False positives are cheap; false negatives let prompt-injection
 * reach an agent.
 */

export interface SanitizeResult {
  /** true = content is safe to include in a dispatch message */
  safe: boolean;
  /** Human-readable reason when safe=false */
  reason?: string;
}

/**
 * Pattern library: regex patterns that indicate injected instructions.
 * Each entry carries a short label used in the `reason` field.
 */
const INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  // HTML comment blocks commonly used to hide LLM instructions
  {
    label: "html-comment-instructions",
    pattern: /<!--[\s\S]*?(ignore|disregard|forget|override|system\s*prompt|new\s*instruction|your\s*task\s*is|act\s*as|you\s*are\s*now|pretend|role\s*play|jailbreak|bypass|STOP|BEGIN\s*NEW)[\s\S]*?-->/i,
  },
  // Standalone "ignore previous instructions" (no comment wrapper needed)
  {
    label: "ignore-previous-instructions",
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|prompts?|context|rules?|constraints?)/i,
  },
  // "Disregard all instructions" variants
  {
    label: "disregard-instructions",
    pattern: /disregard\s+(all\s+)?(previous|prior|above|earlier|your)\s+(instructions?|prompts?|rules?|constraints?|training)/i,
  },
  // Override / new system prompt injection
  {
    label: "system-prompt-override",
    pattern: /\[?\s*(new\s+)?(system\s+prompt|system\s+message|override\s+instructions?)\s*\]?/i,
  },
  // Role-play jailbreaks: "You are now DAN", "act as a", "pretend you are"
  {
    label: "roleplay-jailbreak",
    pattern: /\b(you\s+are\s+now|act\s+as\s+a|pretend\s+(you\s+are|to\s+be)|role[\s-]?play|DAN\b|jailbreak)/i,
  },
  // Unicode bidirectional override characters (invisible text tricks)
  {
    label: "bidi-override",
    // eslint-disable-next-line no-control-regex
    pattern: /[‪-‮⁦-⁩​-‏﻿]/,
  },
  // Zero-width joiners / non-joiners used to hide text
  {
    label: "zero-width-chars",
    pattern: /[‌‍]{3,}/,
  },
  // Known dn-institute honeypot pattern: markdown link with injected anchor text
  {
    label: "dn-institute-honeypot",
    pattern: /\[(?:ignore|system|override|bypass|new\s+task)[^\]]*\]\([^)]*\)/i,
  },
  // Attempts to exfiltrate secrets or tokens
  {
    label: "exfiltration-attempt",
    pattern: /\b(send|post|curl|fetch|http|webhook)\b.{0,80}\b(api.?key|secret|token|password|credential)/i,
  },
];

/**
 * Known-safe org/repo prefixes. External repos NOT on this list require a
 * full sanitizer pass before any clone instruction can be emitted (issue #1553,
 * requirement 4). This list is intentionally narrow — add entries only when the
 * fleet has prior clean experience with that org.
 *
 * Format: lowercase "org" or "org/repo".
 */
export const EXTERNAL_REPO_ALLOWLIST: ReadonlySet<string> = new Set([
  // No orgs yet. Layer 3 of #1512 will add the first vetted entries.
]);

/**
 * Sanitize bounty text content before it is included in a dispatch message.
 *
 * Checks the combined text of all user-controlled fields (title, scope, notes)
 * against the injection pattern library.
 *
 * @param text - concatenation of all user-controlled bounty fields
 * @returns `{ safe: true }` when no patterns match; `{ safe: false, reason }` otherwise
 */
export function sanitizeBountyContent(text: string): SanitizeResult {
  if (!text || text.trim().length === 0) {
    return { safe: true };
  }

  for (const { label, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      return {
        safe: false,
        reason: `injection pattern detected: ${label}`,
      };
    }
  }

  return { safe: true };
}

/**
 * Determine whether a source URL's org is on the external-repo allow-list.
 *
 * Used to enforce requirement 4 of issue #1553: no clone instruction may be
 * emitted for orgs not on the allow-list, regardless of sanitizer outcome.
 *
 * @param sourceUrl - e.g. "https://github.com/some-org/some-repo/issues/42"
 * @returns true if the org (and optionally the full repo slug) is allow-listed
 */
export function isExternalRepoAllowed(sourceUrl: string): boolean {
  try {
    const url = new URL(sourceUrl);
    const parts = url.pathname.replace(/^\//, "").split("/");
    const org = parts[0]?.toLowerCase();
    const repoSlug = parts.slice(0, 2).join("/").toLowerCase();
    if (!org) return false;
    return EXTERNAL_REPO_ALLOWLIST.has(org) || EXTERNAL_REPO_ALLOWLIST.has(repoSlug);
  } catch {
    return false;
  }
}
