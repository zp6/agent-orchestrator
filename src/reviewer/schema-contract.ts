import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SchemaImpactHit } from "./schema-impact.js";

// ── Static contract validator types ──────────────────────────────────────────

/**
 * Drift between one table in schema-contract.json and the DDL in store.ts.
 */
export interface SchemaContractValidationWarning {
  /** Table name from the registry. */
  table: string;
  /**
   * Columns listed in schema-contract.json but absent from store.ts DDL.
   * A non-empty list means the store dropped (or never had) a contract-promised
   * column — downstream consumers that rely on it will break.
   */
  missingFromStore: string[];
  /**
   * Columns present in store.ts DDL but absent from schema-contract.json.
   * A non-empty list means the contract is stale: it does not reflect a column
   * that was added to the store since the contract was last updated.
   */
  extraInStore: string[];
}

/**
 * Result returned by `validateStoreSchemaAgainstContract`.
 */
export interface SchemaContractValidationResult {
  /** One entry per table that has drift. Empty means the contract is up-to-date. */
  warnings: SchemaContractValidationWarning[];
  /** Convenience flag: true when warnings is empty. */
  clean: boolean;
}

export interface SchemaContractTableEntry {
  table: string;
  writer_repo: string;
  consumer_repos: string[];
  canonical_columns: string[];
  notes?: string;
}

export interface SchemaContractRegistry {
  version: number;
  tables: SchemaContractTableEntry[];
}

const CONTRACT_URLS = [
  new URL("./schema-contract.json", import.meta.url),
  new URL("../../src/reviewer/schema-contract.json", import.meta.url),
];

function loadContractText(): string {
  for (const url of CONTRACT_URLS) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  }
  throw new Error("schema-contract.json not found");
}

export function loadSchemaContractRegistry(): SchemaContractRegistry {
  const raw = JSON.parse(loadContractText()) as SchemaContractRegistry;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tables)) {
    throw new Error("Invalid schema contract registry");
  }
  return raw;
}

export function detectSchemaContractDrift(
  diff: string,
  changedFiles: string[],
  registry: SchemaContractRegistry = loadSchemaContractRegistry(),
): SchemaImpactHit[] {
  const hits: SchemaImpactHit[] = [];
  const entriesByTable = new Map(
    registry.tables.map((entry) => [entry.table.toLowerCase(), entry]),
  );

  for (const statement of extractAddedStatements(diff)) {
    const createMatch = statement.match(
      /^CREATE TABLE(?: IF NOT EXISTS)?\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s*\((.*)\)\s*;?$/i,
    );
    if (createMatch) {
      const table = createMatch[1].toLowerCase();
      const entry = entriesByTable.get(table);
      if (!entry) continue;

      const observedColumns = extractColumnsFromCreateTableBody(createMatch[2]);
      const mismatch = compareColumns(entry.canonical_columns, observedColumns);
      hits.push(buildDriftHit(entry, changedFiles, observedColumns, mismatch));
      continue;
    }

    const addColumnMatch = statement.match(
      /^ALTER TABLE\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+ADD COLUMN\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?/i,
    );
    if (addColumnMatch) {
      const table = addColumnMatch[1].toLowerCase();
      const entry = entriesByTable.get(table);
      if (!entry) continue;

      const observedColumns = [addColumnMatch[2]];
      const mismatch = isCanonicalColumn(entry.canonical_columns, observedColumns[0])
        ? { missing: [], extra: [] }
        : { missing: [], extra: [...observedColumns] };
      hits.push(buildDriftHit(entry, changedFiles, observedColumns, mismatch));
      continue;
    }

    const insertMatch = statement.match(
      /^INSERT INTO\s+["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s*\(([^)]+)\)/i,
    );
    if (insertMatch) {
      const table = insertMatch[1].toLowerCase();
      const entry = entriesByTable.get(table);
      if (!entry) continue;

      const observedColumns = insertMatch[2]
        .split(",")
        .map((column) => normalizeColumn(column))
        .filter((column): column is string => column.length > 0);
      const mismatch = compareInsertColumns(entry.canonical_columns, observedColumns);
      hits.push(buildDriftHit(entry, changedFiles, observedColumns, mismatch));
    }
  }

  return dedupeHits(hits);
}

function extractAddedStatements(diff: string): string[] {
  return diff
    .split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line.length > 0 && !line.startsWith("--"));
}

function extractColumnsFromCreateTableBody(body: string): string[] {
  const parts = body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  const columns: string[] = [];
  for (const part of parts) {
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)\b/i.test(part)) {
      continue;
    }
    const match = part.match(/^["`\[]?([A-Za-z_][A-Za-z0-9_]*)["`\]]?\s+/);
    if (match) {
      columns.push(match[1]);
    }
  }
  return columns;
}

function normalizeColumn(value: string): string {
  return value.replace(/[`"\[\]]/g, "").trim();
}

function compareColumns(
  canonicalColumns: string[],
  observedColumns: string[],
): { missing: string[]; extra: string[] } {
  const canonical = new Set(canonicalColumns.map((column) => column.toLowerCase()));
  const observed = new Set(observedColumns.map((column) => column.toLowerCase()));
  return {
    missing: canonicalColumns.filter((column) => !observed.has(column.toLowerCase())),
    extra: observedColumns.filter((column) => !canonical.has(column.toLowerCase())),
  };
}

function compareInsertColumns(
  canonicalColumns: string[],
  observedColumns: string[],
): { missing: string[]; extra: string[] } {
  const canonical = new Set(canonicalColumns.map((column) => column.toLowerCase()));
  return {
    missing: [],
    extra: observedColumns.filter((column) => !canonical.has(column.toLowerCase())),
  };
}

function isCanonicalColumn(canonicalColumns: string[], column: string): boolean {
  const canonical = new Set(canonicalColumns.map((entry) => entry.toLowerCase()));
  return canonical.has(column.toLowerCase());
}

function buildDriftHit(
  entry: SchemaContractTableEntry,
  changedFiles: string[],
  observedColumns: string[],
  mismatch: { missing: string[]; extra: string[] },
): SchemaImpactHit {
  return {
    schemaLabel: `schema contract: ${entry.table}`,
    consumers: [...new Set(entry.consumer_repos)],
    matchedFiles: changedFiles.length > 0 ? [...changedFiles] : [entry.table],
    contractMismatch: mismatch.missing.length > 0 || mismatch.extra.length > 0,
    canonicalColumns: [...entry.canonical_columns],
    observedColumns: [...observedColumns],
    missingColumns: [...mismatch.missing],
    extraColumns: [...mismatch.extra],
  };
}

function dedupeHits(hits: SchemaImpactHit[]): SchemaImpactHit[] {
  const seen = new Set<string>();
  const deduped: SchemaImpactHit[] = [];

  for (const hit of hits) {
    const key = [
      hit.schemaLabel,
      [...hit.consumers].sort().join(","),
      [...hit.matchedFiles].sort().join(","),
      (hit.missingColumns ?? []).sort().join(","),
      (hit.extraColumns ?? []).sort().join(","),
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(hit);
  }

  return deduped;
}

// ── Static store.ts validator (issue #168) ────────────────────────────────────

/**
 * Parse CREATE TABLE and ALTER TABLE ADD COLUMN statements from a full
 * TypeScript/SQL source file and return a map of `tableName → Set<columnName>`.
 *
 * Uses a balanced-parenthesis counter to correctly extract CREATE TABLE bodies
 * even when they contain nested parens (e.g. `DEFAULT (datetime('now'))`).
 *
 * Exported so tests can exercise parsing in isolation without needing a registry.
 */
export function extractStoreColumnsFromSource(source: string): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();

  // ── CREATE TABLE (balanced-paren body extraction) ────────────────────────
  const createTableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`\[]?(\w+)["`\]]?\s*\(/gi;
  let m: RegExpExecArray | null;

  while ((m = createTableRe.exec(source)) !== null) {
    const tableName = m[1].toLowerCase();
    const bodyStart = m.index + m[0].length;

    // Walk forward counting parentheses to find the matching closing paren.
    let depth = 1;
    let pos = bodyStart;
    while (pos < source.length && depth > 0) {
      const ch = source[pos];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      pos++;
    }
    if (depth !== 0) continue; // malformed statement — skip

    const body = source.slice(bodyStart, pos - 1);
    const cols = extractColumnsFromCreateTableBody(body);

    if (!result.has(tableName)) result.set(tableName, new Set());
    for (const col of cols) result.get(tableName)!.add(col.toLowerCase());
  }

  // ── ALTER TABLE … ADD COLUMN ─────────────────────────────────────────────
  const alterRe =
    /ALTER\s+TABLE\s+["`\[]?(\w+)["`\]]?\s+ADD\s+COLUMN\s+["`\[]?(\w+)["`\]]?/gi;

  while ((m = alterRe.exec(source)) !== null) {
    const tableName = m[1].toLowerCase();
    const colName = m[2].toLowerCase();
    if (!result.has(tableName)) result.set(tableName, new Set());
    result.get(tableName)!.add(colName);
  }

  return result;
}

/**
 * Validate the complete DDL in a store.ts source file against schema-contract.json.
 *
 * Unlike `detectSchemaContractDrift()` (which works on a git diff and only sees
 * the lines changed in the current PR), this function parses the **full source
 * file** so it detects accumulated drift introduced across multiple PRs.
 *
 * Use this as a CI gate: if the function returns `{ clean: false }`, someone
 * added a column to store.ts without updating schema-contract.json.
 *
 * Tables present in the registry but absent from store.ts are **skipped** —
 * they are owned by a different `writer_repo` and should be validated there.
 *
 * @param storeSource  Full text content of src/state/store.ts.
 * @param registry     Schema contract registry (defaults to loading the bundled
 *                     schema-contract.json).
 */
export function validateStoreSchemaAgainstContract(
  storeSource: string,
  registry: SchemaContractRegistry = loadSchemaContractRegistry(),
): SchemaContractValidationResult {
  const storeColumns = extractStoreColumnsFromSource(storeSource);
  const warnings: SchemaContractValidationWarning[] = [];

  for (const entry of registry.tables) {
    const tableName = entry.table.toLowerCase();
    const storeCols = storeColumns.get(tableName);

    // Skip tables not present in this store.ts.
    // They are likely owned by a different writer_repo (e.g. rapartlu/agent-orchestrator)
    // and should be validated in that repo's own CI check.
    if (storeCols === undefined) continue;

    const canonicalSet = new Set(entry.canonical_columns.map((c) => c.toLowerCase()));

    const missingFromStore = entry.canonical_columns.filter(
      (c) => !storeCols.has(c.toLowerCase()),
    );
    const extraInStore = [...storeCols].filter((c) => !canonicalSet.has(c));

    if (missingFromStore.length > 0 || extraInStore.length > 0) {
      warnings.push({ table: entry.table, missingFromStore, extraInStore });
    }
  }

  return { warnings, clean: warnings.length === 0 };
}
