import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SchemaImpactHit } from "./schema-impact.js";

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
