/**
 * Cross-repo schema contract registry checker for PR reviews.
 *
 * Loads `src/config/schema-registry.json` — the canonical declaration of
 * column names for every shared SQLite table — and detects drift between what
 * a PR introduces and what the registry declares.
 *
 * Motivation (task 01KP654X):
 *   The orchestrator wrote `learned_patterns` with different column names than
 *   the dashboard read, causing the immune-system panel to silently show
 *   "No patterns found" despite active data.  This module catches that class
 *   of bug at PR-review time rather than at runtime.
 *
 * Design:
 *   1. `loadSchemaRegistry()` — reads + validates the JSON registry file.
 *   2. `detectSchemaContractDrift(diff, changedFiles)` — parses the diff for
 *      CREATE/ALTER/INSERT statements and flags mismatches with the registry.
 *   3. `buildSchemaContractNotice(hits)` — formats hits into a prompt section
 *      for injection into the LLM PR-review prompt.
 *
 * Review policy:
 *   Schema contract mismatches are a **flagged risk**, not an auto-block.
 *   The notice is injected into the review prompt so the LLM can call it out
 *   in its comment, consistent with the "default to approve" review policy.
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createLogger } from "../service/logger.js";

const log = createLogger("schema-impact");

// ── Registry types ─────────────────────────────────────────────────────────

export interface SchemaRegistryTableEntry {
  /** SQLite table name (lower-case canonical form). */
  table: string;
  /** Repo that owns the CREATE TABLE statement. */
  writer_repo: string;
  /** Repos that SELECT from or otherwise depend on this table. */
  consumer_repos: string[];
  /** Canonical column names in the order they appear in the CREATE TABLE. */
  canonical_columns: string[];
  /** Optional human-readable notes surfaced in review comments. */
  notes?: string;
}

export interface SchemaRegistry {
  version: number;
  description?: string;
  tables: SchemaRegistryTableEntry[];
}

// ── Impact hit types ───────────────────────────────────────────────────────

export interface SchemaContractHit {
  /** Human-readable label for the affected table. */
  schemaLabel: string;
  /** Table name that triggered the hit. */
  table: string;
  /** Repos that consume this table and may be affected. */
  consumers: string[];
  /** File paths in the PR that matched the registry table. */
  matchedFiles: string[];
  /** True when column-name drift is detected between the PR and the registry. */
  contractMismatch: boolean;
  /** Canonical columns from the registry. */
  canonicalColumns: string[];
  /** Column names extracted from the PR diff. */
  observedColumns: string[];
  /** Columns in the registry that are absent from the PR diff. */
  missingColumns: string[];
  /** Columns introduced by the PR diff that are not in the registry. */
  extraColumns: string[];
  /** Optional notes from the registry entry. */
  notes?: string;
}

// ── Registry loading ───────────────────────────────────────────────────────

const REGISTRY_PATHS = [
  new URL("../../src/config/schema-registry.json", import.meta.url),
  new URL("../config/schema-registry.json", import.meta.url),
];

/**
 * Load and validate the schema registry JSON file.
 * Throws if the file is missing or malformed.
 */
export function loadSchemaRegistry(): SchemaRegistry {
  for (const url of REGISTRY_PATHS) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as SchemaRegistry;
        if (!raw || typeof raw !== "object" || !Array.isArray(raw.tables)) {
          throw new Error("schema-registry.json must have a 'tables' array");
        }
        return raw;
      } catch (err) {
        throw new Error(`Failed to parse schema-registry.json at ${path}: ${String(err)}`);
      }
    }
  }
  throw new Error(
    `schema-registry.json not found. Tried: ${REGISTRY_PATHS.map((u) => fileURLToPath(u)).join(", ")}`,
  );
}

// ── Diff parsing helpers ───────────────────────────────────────────────────

/**
 * Extract only the added lines from a unified diff (lines starting with '+',
 * excluding '+++ file header' lines).
 */
function extractAddedLines(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
}

/**
 * Reconstruct multi-line SQL statements from a flat list of added lines.
 * Joins lines into statement chunks separated by semicolons.
 */
function extractSQLStatements(lines: string[]): string[] {
  const statements: string[] = [];
  let current = "";

  for (const line of lines) {
    current += " " + line;
    if (line.trimEnd().endsWith(";") || /;\s*$/.test(line)) {
      statements.push(current.trim());
      current = "";
    }
  }
  if (current.trim().length > 0) {
    statements.push(current.trim());
  }
  return statements;
}

/**
 * Parse column names from the body of a CREATE TABLE statement.
 * Skips table constraints (PRIMARY KEY, FOREIGN KEY, UNIQUE, CHECK).
 */
function parseCreateTableColumns(body: string): string[] {
  const columns: string[] = [];
  // Split on commas, but only top-level (not inside nested parens)
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of body) {
    if (ch === "(") { depth++; current += ch; }
    else if (ch === ")") { depth--; current += ch; }
    else if (ch === "," && depth === 0) { parts.push(current.trim()); current = ""; }
    else { current += ch; }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part.trim())) continue;
    const match = part.trim().match(/^["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+/);
    if (match) columns.push(match[1]);
  }
  return columns;
}

/** Normalise a column name by stripping quotes and whitespace. */
function normaliseColumn(col: string): string {
  return col.replace(/[`"[\]]/g, "").trim();
}

/** Compare canonical vs observed column sets; return missing and extra. */
function compareColumnSets(
  canonical: string[],
  observed: string[],
): { missing: string[]; extra: string[] } {
  const canonicalSet = new Set(canonical.map((c) => c.toLowerCase()));
  const observedSet = new Set(observed.map((c) => c.toLowerCase()));
  return {
    missing: canonical.filter((c) => !observedSet.has(c.toLowerCase())),
    extra: observed.filter((c) => !canonicalSet.has(c.toLowerCase())),
  };
}

/**
 * Extract changed file paths from a unified diff.
 * Parses `diff --git a/<path>` headers first; falls back to `+++ b/<path>`.
 */
export function extractChangedFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(.+) b\/.+$/gm)) {
    files.add(m[1]);
  }
  if (files.size === 0) {
    for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
      if (m[1] !== "/dev/null") files.add(m[1]);
    }
  }
  return [...files];
}

// ── Contract drift detection ───────────────────────────────────────────────

/**
 * Detect schema contract drift in a PR diff.
 *
 * For each table registered in the schema registry, checks whether the PR
 * diff introduces a CREATE TABLE or ALTER TABLE ADD COLUMN statement whose
 * column names diverge from the canonical list.  Also detects INSERT INTO
 * statements referencing unknown columns.
 *
 * @param diff          Full unified diff text from `gh pr diff`
 * @param changedFiles  List of changed file paths (from PR metadata or parsed
 *                      from `diff` via `extractChangedFiles`)
 * @param registry      Registry to use; defaults to the checked-in JSON file
 * @returns             Array of drift hits (empty when no drift found)
 */
export function detectSchemaContractDrift(
  diff: string,
  changedFiles: string[],
  registry: SchemaRegistry = loadSchemaRegistry(),
): SchemaContractHit[] {
  const hits: SchemaContractHit[] = [];
  const byTable = new Map(registry.tables.map((e) => [e.table.toLowerCase(), e]));
  const addedLines = extractAddedLines(diff);
  const statements = extractSQLStatements(addedLines);

  // Also check raw added lines for quick inline CREATE TABLE patterns
  const allText = addedLines.join(" ");

  for (const stmt of statements) {
    // ── CREATE TABLE ────────────────────────────────────────────────────────
    const createMatch = stmt.match(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s*\((.+)\)/is,
    );
    if (createMatch) {
      const table = createMatch[1].toLowerCase();
      const entry = byTable.get(table);
      if (!entry) continue;

      const observedColumns = parseCreateTableColumns(createMatch[2]);
      const { missing, extra } = compareColumnSets(entry.canonical_columns, observedColumns);
      hits.push({
        schemaLabel: `schema contract: ${entry.table}`,
        table: entry.table,
        consumers: [...entry.consumer_repos],
        matchedFiles: changedFiles.filter((f) =>
          f.toLowerCase().includes("store") ||
          f.toLowerCase().includes("schema") ||
          f.toLowerCase().includes("migration"),
        ),
        contractMismatch: missing.length > 0 || extra.length > 0,
        canonicalColumns: [...entry.canonical_columns],
        observedColumns,
        missingColumns: missing,
        extraColumns: extra,
        notes: entry.notes,
      });
      continue;
    }

    // ── ALTER TABLE ADD COLUMN ───────────────────────────────────────────────
    const alterMatch = stmt.match(
      /ALTER\s+TABLE\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+ADD\s+COLUMN\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/i,
    );
    if (alterMatch) {
      const table = alterMatch[1].toLowerCase();
      const entry = byTable.get(table);
      if (!entry) continue;

      const colName = normaliseColumn(alterMatch[2]);
      const canonicalSet = new Set(entry.canonical_columns.map((c) => c.toLowerCase()));
      const isKnown = canonicalSet.has(colName.toLowerCase());
      hits.push({
        schemaLabel: `schema contract: ${entry.table}`,
        table: entry.table,
        consumers: [...entry.consumer_repos],
        matchedFiles: changedFiles.filter((f) =>
          f.toLowerCase().includes("store") ||
          f.toLowerCase().includes("schema") ||
          f.toLowerCase().includes("migration"),
        ),
        contractMismatch: !isKnown,
        canonicalColumns: [...entry.canonical_columns],
        observedColumns: [colName],
        missingColumns: [],
        extraColumns: isKnown ? [] : [colName],
        notes: entry.notes,
      });
      continue;
    }

    // ── INSERT INTO (column list) ────────────────────────────────────────────
    const insertMatch = stmt.match(
      /INSERT\s+INTO\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s*\(([^)]+)\)/i,
    );
    if (insertMatch) {
      const table = insertMatch[1].toLowerCase();
      const entry = byTable.get(table);
      if (!entry) continue;

      const observedColumns = insertMatch[2]
        .split(",")
        .map(normaliseColumn)
        .filter((c) => c.length > 0);

      const canonicalSet = new Set(entry.canonical_columns.map((c) => c.toLowerCase()));
      const extra = observedColumns.filter((c) => !canonicalSet.has(c.toLowerCase()));

      if (extra.length > 0) {
        hits.push({
          schemaLabel: `schema contract: ${entry.table}`,
          table: entry.table,
          consumers: [...entry.consumer_repos],
          matchedFiles: changedFiles,
          contractMismatch: true,
          canonicalColumns: [...entry.canonical_columns],
          observedColumns,
          missingColumns: [],
          extraColumns: extra,
          notes: entry.notes,
        });
      }
    }
  }

  return dedupeHits(hits);
}

/** Remove duplicate hits (same table + same column delta). */
function dedupeHits(hits: SchemaContractHit[]): SchemaContractHit[] {
  const seen = new Set<string>();
  const out: SchemaContractHit[] = [];
  for (const hit of hits) {
    const key = [
      hit.table,
      [...hit.missingColumns].sort().join(","),
      [...hit.extraColumns].sort().join(","),
    ].join("|");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(hit);
    }
  }
  return out;
}

// ── Notice formatting ──────────────────────────────────────────────────────

/**
 * Format schema contract drift hits into a prompt section for the LLM
 * PR-review prompt.  Returns an empty string when there are no hits.
 *
 * The section is deliberately non-blocking: it asks the LLM to flag the
 * risk in its comment rather than auto-blocking the PR.
 */
export function buildSchemaContractNotice(hits: SchemaContractHit[]): string {
  const driftHits = hits.filter((h) => h.contractMismatch);
  if (driftHits.length === 0) return "";

  const lines: string[] = [
    "",
    "### ⚠️ Schema Contract Registry — Column-Name Drift Detected",
    "",
    "The schema contract registry (`src/config/schema-registry.json`) declares the",
    "canonical column names for shared SQLite tables. This PR introduces column names",
    "that diverge from the registry. Consumers of these tables may silently break.",
    "",
    "**Policy:** This is a flagged risk, not an auto-block. Include a callout in your",
    "review comment. Approve if the code is otherwise correct AND the consumer repos",
    "are being updated in a follow-up PR.",
    "",
  ];

  for (const hit of driftHits) {
    lines.push(`**Table:** \`${hit.table}\``);
    lines.push(`**Consumers:** ${hit.consumers.join(", ")}`);
    if (hit.missingColumns.length > 0) {
      lines.push(`**Missing from PR (registry expects):** \`${hit.missingColumns.join("`, `")}\``);
    }
    if (hit.extraColumns.length > 0) {
      lines.push(`**Extra in PR (not in registry):** \`${hit.extraColumns.join("`, `")}\``);
    }
    if (hit.notes) {
      lines.push(`**Notes:** ${hit.notes}`);
    }
    lines.push("");
  }

  lines.push(
    "Update `src/config/schema-registry.json` in this PR if the column change is",
    "intentional, and open issues in the consumer repos to update their readers.",
  );

  return lines.join("\n");
}

/**
 * Run schema contract drift detection on a PR diff and return a formatted
 * notice string ready to inject into a review prompt.  Logs any registry
 * load errors as warnings (non-fatal — review continues without the notice).
 */
export function checkSchemaContractDrift(
  diff: string,
  changedFiles: string[],
): string {
  try {
    const registry = loadSchemaRegistry();
    const hits = detectSchemaContractDrift(diff, changedFiles, registry);
    return buildSchemaContractNotice(hits);
  } catch (err) {
    log.warn("Schema contract drift check skipped (non-fatal)", { error: String(err) });
    return "";
  }
}
