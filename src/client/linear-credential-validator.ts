/**
 * Linear Credential Validator
 *
 * Validates that LINEAR_API_KEY is configured before attempting to use the Linear API.
 * Provides actionable feedback to the Operator when credentials are missing or invalid.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface CredentialValidationResult {
  valid: boolean;
  apiKey: string | null;
  errorMessage: string | null;
  suggestions: string[];
}

/**
 * Validate LINEAR_API_KEY from ~/.claude-orchestrator/.env
 *
 * Returns:
 * - valid: true if credential exists and is not a placeholder
 * - apiKey: the credential value (or null if invalid)
 * - errorMessage: human-readable error if validation failed
 * - suggestions: actionable steps to resolve the issue
 */
export function validateLinearCredential(): CredentialValidationResult {
  const envPath = join(homedir(), ".claude-orchestrator", ".env");

  try {
    const envContent = readFileSync(envPath, "utf-8");
    const lines = envContent.split("\n");

    let apiKey = "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("LINEAR_API_KEY=")) {
        apiKey = trimmed.split("=")[1];
        break;
      }
    }

    // Check for placeholder or empty value
    if (!apiKey) {
      return {
        valid: false,
        apiKey: null,
        errorMessage: "LINEAR_API_KEY not found in ~/.claude-orchestrator/.env",
        suggestions: [
          "1. Edit ~/.claude-orchestrator/.env",
          "2. Locate the LINEAR_API_KEY line",
          "3. Replace 'lin_api_...' with your actual key from Linear Settings → API",
          "4. Save the file",
          "5. Restart any processes using this credential",
        ],
      };
    }

    if (apiKey.includes("...") || apiKey === "lin_api_...") {
      return {
        valid: false,
        apiKey: null,
        errorMessage: `LINEAR_API_KEY is a placeholder: "${apiKey}"`,
        suggestions: [
          "To get your Linear API key:",
          "1. Go to https://linear.app/settings/api",
          "2. Create a personal API key (or use existing one)",
          "3. Copy the full key (format: lin_api_XXXXX...)",
          "4. Update ~/.claude-orchestrator/.env",
          "5. Replace 'lin_api_...' with the real key",
          "6. Save and restart processes",
        ],
      };
    }

    if (!apiKey.startsWith("lin_api_")) {
      return {
        valid: false,
        apiKey: null,
        errorMessage: `LINEAR_API_KEY has invalid format: "${apiKey}"`,
        suggestions: [
          "Linear API keys must start with 'lin_api_'",
          "Check that you copied the full key from Linear Settings",
          "Expected format: lin_api_XXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        ],
      };
    }

    // Validation passed
    return {
      valid: true,
      apiKey,
      errorMessage: null,
      suggestions: [],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      apiKey: null,
      errorMessage: `Failed to read credentials from ${envPath}: ${message}`,
      suggestions: [
        `Ensure the file exists: ${envPath}`,
        "Create it with: mkdir -p ~/.claude-orchestrator && touch ~/.claude-orchestrator/.env",
        "Add the line: LINEAR_API_KEY=lin_api_<your-key-from-Linear>",
      ],
    };
  }
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
      `Linear credential validation failed: ${result.errorMessage}\n\n  ${suggestions}`
    );
  }

  return result.apiKey!;
}
