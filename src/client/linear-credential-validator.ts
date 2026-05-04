/**
 * Linear Credential Validator
 *
 * Validates that LINEAR_API_KEY is configured before attempting to use the Linear API.
 * Provides actionable feedback to the Operator when credentials are missing or invalid.
 *
 * Lookup order (issue #1490):
 *   1. `~/.claude-orchestrator/.env` — operator-host path; works when the daemon
 *      runs on the operator's machine and reads from $HOME.
 *   2. `/run/secrets/<agent>_linear_api_key` — container-friendly path; works
 *      when the agent runs inside docker / k8s with mounted secrets, alongside
 *      the existing `<agent>_gh_token` and `<agent>_oauth_token` mounts.
 *
 * The first source that yields a valid key wins. Both sources go through
 * the same placeholder / format checks so the validator never returns a
 * "valid but unusable" result.
 */

import { readFileSync, existsSync } from "fs";
import { homedir, hostname } from "os";
import { join } from "path";

export interface CredentialValidationResult {
  valid: boolean;
  apiKey: string | null;
  errorMessage: string | null;
  suggestions: string[];
  /**
   * Where the validated key was sourced from (or null when invalid).
   * Useful for audit logs and for debugging cross-environment differences.
   */
  source?: "env-file" | "secrets-mount" | null;
}

interface LookupResult {
  /** The raw value found, or null when this path yielded nothing. */
  value: string | null;
  /** Human-readable description of the path that was inspected. */
  pathDescription: string;
  /** Underlying read error, if the path was attempted but unreadable. */
  errorMessage: string | null;
}

/**
 * Read LINEAR_API_KEY from `~/.claude-orchestrator/.env` (KEY=VALUE format).
 * Returns `value: null` when the file is missing or the key isn't in it,
 * and propagates an error message when the file exists but can't be read.
 */
function readKeyFromEnvFile(): LookupResult {
  const envPath = join(homedir(), ".claude-orchestrator", ".env");
  try {
    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("LINEAR_API_KEY=")) {
        return {
          value: trimmed.slice("LINEAR_API_KEY=".length),
          pathDescription: envPath,
          errorMessage: null,
        };
      }
    }
    return { value: null, pathDescription: envPath, errorMessage: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: null, pathDescription: envPath, errorMessage: message };
  }
}

/**
 * Determine the agent name used to build the secrets-mount path.
 * Order: explicit AGENT_NAME env var, then container HOSTNAME, then null.
 * Empty / whitespace-only values are treated as not-set.
 */
function resolveAgentName(): string | null {
  const fromEnv = (process.env.AGENT_NAME ?? "").trim();
  if (fromEnv) return fromEnv;
  const fromHostname = (hostname() ?? "").trim();
  return fromHostname || null;
}

/**
 * Read LINEAR_API_KEY from the docker / k8s secrets-mount path
 * `/run/secrets/<agent>_linear_api_key`. The file contains the raw key
 * (no `KEY=` prefix), matching how `gh_token` is delivered today.
 *
 * Returns `value: null` when the file does not exist (the common case
 * when the secret isn't provisioned for this agent — not an error).
 */
function readKeyFromSecretsMount(): LookupResult {
  const agentName = resolveAgentName();
  const secretPath = agentName
    ? `/run/secrets/${agentName}_linear_api_key`
    : "/run/secrets/linear_api_key";

  if (!existsSync(secretPath)) {
    return { value: null, pathDescription: secretPath, errorMessage: null };
  }

  try {
    const raw = readFileSync(secretPath, "utf-8").trim();
    return { value: raw, pathDescription: secretPath, errorMessage: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { value: null, pathDescription: secretPath, errorMessage: message };
  }
}

/**
 * Apply the same placeholder / format rules to any candidate key value.
 * Returns the validated key on success, or a structured failure describing
 * what was wrong so the caller can attempt the next source.
 */
function classifyCandidateKey(
  value: string | null,
): { ok: true; apiKey: string } | { ok: false; reason: string } {
  if (!value) {
    return { ok: false, reason: "not found" };
  }
  if (value.includes("...") || value === "lin_api_...") {
    return { ok: false, reason: `placeholder: "${value}"` };
  }
  if (!value.startsWith("lin_api_")) {
    return { ok: false, reason: `invalid format: "${value}"` };
  }
  return { ok: true, apiKey: value };
}

/**
 * Validate LINEAR_API_KEY across the env-file and secrets-mount paths.
 *
 * Returns:
 * - valid: true if any source produced a valid (non-placeholder, lin_api_*) key
 * - apiKey: the credential value (or null if invalid)
 * - errorMessage: human-readable error if validation failed
 * - suggestions: actionable steps to resolve the issue
 * - source: which path produced the validated key, or null when invalid
 */
export function validateLinearCredential(): CredentialValidationResult {
  const envLookup = readKeyFromEnvFile();
  const envClassification = classifyCandidateKey(envLookup.value);
  if (envClassification.ok) {
    return {
      valid: true,
      apiKey: envClassification.apiKey,
      errorMessage: null,
      suggestions: [],
      source: "env-file",
    };
  }

  const mountLookup = readKeyFromSecretsMount();
  const mountClassification = classifyCandidateKey(mountLookup.value);
  if (mountClassification.ok) {
    return {
      valid: true,
      apiKey: mountClassification.apiKey,
      errorMessage: null,
      suggestions: [],
      source: "secrets-mount",
    };
  }

  // Build a forensic-quality failure message that names every attempted path
  // so operators see the full picture in one log line.
  const reasons: string[] = [];
  if (envLookup.errorMessage) {
    reasons.push(`${envLookup.pathDescription}: ${envLookup.errorMessage}`);
  } else {
    reasons.push(`${envLookup.pathDescription}: ${envClassification.reason}`);
  }
  if (mountLookup.errorMessage) {
    reasons.push(`${mountLookup.pathDescription}: ${mountLookup.errorMessage}`);
  } else {
    reasons.push(`${mountLookup.pathDescription}: ${mountClassification.reason}`);
  }

  return {
    valid: false,
    apiKey: null,
    errorMessage: `LINEAR_API_KEY not available — ${reasons.join("; ")}`,
    suggestions: [
      "Linear credentials can be provided via either path:",
      "  (a) ~/.claude-orchestrator/.env — for daemon-host agents",
      "      Add line: LINEAR_API_KEY=lin_api_<your-key-from-Linear>",
      "  (b) /run/secrets/<agent>_linear_api_key — for containerized agents",
      "      Same mechanism that delivers <agent>_gh_token and <agent>_oauth_token",
      "Get the key at https://linear.app/settings/api (format: lin_api_XXXXX...).",
      "Restart processes / re-mount the secret after updating.",
    ],
    source: null,
  };
}

/**
 * Assert that Linear credentials are valid, or throw with helpful error.
 *
 * Use this in task dispatches to fail fast with actionable feedback.
 */
export function assertLinearCredential(): string {
  const result = validateLinearCredential();

  if (!result.valid) {
    const suggestions = result.suggestions.join("\n  ");
    throw new Error(
      `Linear credential validation failed: ${result.errorMessage}\n\n  ${suggestions}`,
    );
  }

  return result.apiKey!;
}
