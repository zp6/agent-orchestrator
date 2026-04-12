/**
 * Robust JSON extraction from LLM responses.
 *
 * LLMs wrap JSON in code fences, explanation text, trailing commentary,
 * or return it as plain text with no delimiters. This module provides a
 * single extraction function that tries multiple strategies in order.
 *
 * Used by: verification parser, PR review parser, improvement detector,
 * supervisor parser, roadmap proposer, team meeting synthesis.
 */
import { createLogger } from "../service/logger.js";

const log = createLogger("json-extract");

/**
 * Extract a JSON object from LLM response text.
 * Tries strategies in order of specificity:
 *   1. Strip code fences and parse directly
 *   2. Regex extract first JSON object containing a required key
 *   3. Find JSON inside code fences
 *   4. Find JSON array
 * Returns the parsed object/array, or null if all strategies fail.
 */
export function extractJSON<T = unknown>(text: string, requiredKey?: string): T | null {
  const strategies: Array<() => unknown> = [
    // 1. Strip code fences and parse the whole thing
    () => JSON.parse(text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim()),

    // 2. Extract first JSON object containing a required key
    () => {
      if (!requiredKey) throw new Error("skip");
      const re = new RegExp(`\\{[\\s\\S]*?"${requiredKey}"[\\s\\S]*?\\}`);
      const match = text.match(re);
      if (!match) throw new Error("no match");
      return JSON.parse(match[0]);
    },

    // 3. Find JSON between code fences
    () => {
      const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (!match) throw new Error("no fence");
      return JSON.parse(match[1].trim());
    },

    // 4. Find JSON array anywhere
    () => {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("no array");
      return JSON.parse(match[0]);
    },
  ];

  for (const strategy of strategies) {
    try {
      const result = strategy();
      if (result !== null && result !== undefined) return result as T;
    } catch {
      continue;
    }
  }

  log.warn("All JSON extraction strategies failed", {
    textLength: text.length,
    preview: text.slice(0, 150),
  });
  return null;
}

/**
 * Extract a JSON object and validate it has required fields.
 * Returns null if extraction fails or required fields are missing.
 */
export function extractAndValidate<T extends Record<string, unknown>>(
  text: string,
  requiredFields: string[],
): T | null {
  const result = extractJSON<T>(text, requiredFields[0]);
  if (!result || typeof result !== "object") return null;

  for (const field of requiredFields) {
    if (!(field in result)) {
      log.warn("Extracted JSON missing required field", { field, keys: Object.keys(result) });
      return null;
    }
  }

  return result;
}
