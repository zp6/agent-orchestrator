/**
 * Schema-contract CI validator tests (issue #168).
 *
 * Two test suites:
 *
 * 1. **CI gate** — reads the actual src/state/store.ts and asserts it is
 *    consistent with src/reviewer/schema-contract.json.  This test will fail
 *    in CI if a developer adds a column to store.ts without updating the
 *    contract (or vice versa), closing the drift loop that
 *    detectSchemaContractDrift() alone could not catch across multiple PRs.
 *
 * 2. **Unit tests** — exercise the validator and parser with synthetic sources
 *    to verify the warning logic works correctly in isolation.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  validateStoreSchemaAgainstContract,
  extractStoreColumnsFromSource,
  loadSchemaContractRegistry,
} from "../reviewer/schema-contract.js";
import type {
  SchemaContractRegistry,
} from "../reviewer/schema-contract.js";

// ── CI gate ───────────────────────────────────────────────────────────────────

describe("schema-contract CI gate", () => {
  it("store.ts DDL matches schema-contract.json (no stale drift)", () => {
    const storePath = fileURLToPath(new URL("../state/store.ts", import.meta.url));
    const storeSource = readFileSync(storePath, "utf-8");

    const result = validateStoreSchemaAgainstContract(storeSource);

    if (!result.clean) {
      const details = result.warnings
        .map((w) => {
          const lines = [`  table: ${w.table}`];
          if (w.missingFromStore.length > 0)
            lines.push(
              `    in schema-contract.json but missing from store.ts: ${w.missingFromStore.join(", ")}`,
            );
          if (w.extraInStore.length > 0)
            lines.push(
              `    in store.ts but missing from schema-contract.json: ${w.extraInStore.join(", ")}`,
            );
          return lines.join("\n");
        })
        .join("\n");

      throw new Error(
        `schema-contract.json is stale — update it to match store.ts DDL:\n${details}\n\n` +
          `Add or remove canonical_columns entries for the table(s) above.`,
      );
    }

    expect(result.clean).toBe(true);
  });
});

// ── Unit tests ────────────────────────────────────────────────────────────────

/** Minimal registry fixture for unit tests. */
function makeRegistry(tables: SchemaContractRegistry["tables"]): SchemaContractRegistry {
  return { version: 1, tables };
}

describe("validateStoreSchemaAgainstContract", () => {
  it("returns clean when store columns exactly match the contract", () => {
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL
        );
      \`);
    `;
    const registry = makeRegistry([
      {
        table: "tasks",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "title", "status"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("warns when store has a column not in the contract (extraInStore)", () => {
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          priority INTEGER NOT NULL DEFAULT 0
        );
      \`);
    `;
    const registry = makeRegistry([
      {
        table: "tasks",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "title", "status"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].table).toBe("tasks");
    expect(result.warnings[0].extraInStore).toContain("priority");
    expect(result.warnings[0].missingFromStore).toHaveLength(0);
  });

  it("warns when the contract lists a column absent from the store (missingFromStore)", () => {
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS pr_reviews (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          pr_number INTEGER NOT NULL
        );
      \`);
    `;
    const registry = makeRegistry([
      {
        table: "pr_reviews",
        writer_repo: "test/repo",
        consumer_repos: ["test/consumer"],
        canonical_columns: ["id", "repo", "pr_number", "decision", "confidence"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(false);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].missingFromStore).toContain("decision");
    expect(result.warnings[0].missingFromStore).toContain("confidence");
    expect(result.warnings[0].extraInStore).toHaveLength(0);
  });

  it("includes ALTER TABLE ADD COLUMN columns in the comparison", () => {
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS supervisor_decisions (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          reason TEXT NOT NULL
        );
      \`);
      try {
        db.exec("ALTER TABLE supervisor_decisions ADD COLUMN message TEXT");
      } catch {}
    `;
    const registry = makeRegistry([
      {
        table: "supervisor_decisions",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "action", "reason", "message"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(true);
  });

  it("skips tables in the contract that are absent from store.ts (owned by another repo)", () => {
    // store.ts only defines pr_reviews; the contract also has learned_patterns
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS pr_reviews (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL
        );
      \`);
    `;
    const registry = makeRegistry([
      {
        table: "pr_reviews",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "repo"],
      },
      {
        table: "learned_patterns",
        writer_repo: "other/repo",
        consumer_repos: [],
        canonical_columns: ["id", "pattern_name", "pattern_value"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    // learned_patterns is absent from this store — should be skipped, not warned
    expect(result.clean).toBe(true);
  });

  it("reports multiple drifted tables in a single result", () => {
    const source = `
      db.exec(\`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          extra_col TEXT
        );
        CREATE TABLE IF NOT EXISTS pr_reviews (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL
        );
      \`);
    `;
    const registry = makeRegistry([
      {
        table: "tasks",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "title"],
      },
      {
        table: "pr_reviews",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "repo", "missing_col"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(false);
    expect(result.warnings).toHaveLength(2);

    const tasksWarning = result.warnings.find((w) => w.table === "tasks");
    expect(tasksWarning?.extraInStore).toContain("extra_col");

    const prWarning = result.warnings.find((w) => w.table === "pr_reviews");
    expect(prWarning?.missingFromStore).toContain("missing_col");
  });

  it("is case-insensitive for column name matching", () => {
    const source = `
      CREATE TABLE tasks (
        ID TEXT PRIMARY KEY,
        TITLE TEXT NOT NULL
      );
    `;
    const registry = makeRegistry([
      {
        table: "tasks",
        writer_repo: "test/repo",
        consumer_repos: [],
        canonical_columns: ["id", "title"],
      },
    ]);
    const result = validateStoreSchemaAgainstContract(source, registry);
    expect(result.clean).toBe(true);
  });
});

// ── extractStoreColumnsFromSource ─────────────────────────────────────────────

describe("extractStoreColumnsFromSource", () => {
  it("extracts columns from a simple CREATE TABLE statement", () => {
    const source = `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT
      );
    `;
    const cols = extractStoreColumnsFromSource(source);
    expect(cols.has("tasks")).toBe(true);
    const taskCols = cols.get("tasks")!;
    expect(taskCols.has("id")).toBe(true);
    expect(taskCols.has("title")).toBe(true);
    expect(taskCols.has("status")).toBe(true);
  });

  it("handles CREATE TABLE IF NOT EXISTS", () => {
    const source = `
      CREATE TABLE IF NOT EXISTS pr_reviews (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL
      );
    `;
    const cols = extractStoreColumnsFromSource(source);
    expect(cols.has("pr_reviews")).toBe(true);
    expect(cols.get("pr_reviews")!.has("repo")).toBe(true);
  });

  it("correctly handles nested parens in DEFAULT clauses", () => {
    const source = `
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `;
    const cols = extractStoreColumnsFromSource(source);
    const taskCols = cols.get("tasks")!;
    // should have all 3 columns, not break on nested parens
    expect(taskCols.size).toBe(3);
    expect(taskCols.has("id")).toBe(true);
    expect(taskCols.has("created_at")).toBe(true);
    expect(taskCols.has("updated_at")).toBe(true);
  });

  it("extracts ALTER TABLE ADD COLUMN statements", () => {
    const source = `
      CREATE TABLE tasks (id TEXT PRIMARY KEY);
      ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN quality_explanation TEXT;
    `;
    const cols = extractStoreColumnsFromSource(source);
    const taskCols = cols.get("tasks")!;
    expect(taskCols.has("priority")).toBe(true);
    expect(taskCols.has("quality_explanation")).toBe(true);
  });

  it("skips constraint lines (PRIMARY KEY, UNIQUE, etc.)", () => {
    const source = `
      CREATE TABLE tasks (
        id TEXT,
        title TEXT,
        PRIMARY KEY (id),
        UNIQUE (title)
      );
    `;
    const cols = extractStoreColumnsFromSource(source);
    const taskCols = cols.get("tasks")!;
    expect(taskCols.has("id")).toBe(true);
    expect(taskCols.has("title")).toBe(true);
    // constraint lines should not be treated as column names
    expect(taskCols.has("primary")).toBe(false);
    expect(taskCols.has("unique")).toBe(false);
  });

  it("handles multiple tables in one source", () => {
    const source = `
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
      CREATE TABLE pr_reviews (id TEXT PRIMARY KEY, repo TEXT, pr_number INTEGER);
    `;
    const cols = extractStoreColumnsFromSource(source);
    expect(cols.has("tasks")).toBe(true);
    expect(cols.has("pr_reviews")).toBe(true);
    expect(cols.get("tasks")!.size).toBe(2);
    expect(cols.get("pr_reviews")!.size).toBe(3);
  });

  it("normalises column names to lowercase", () => {
    const source = `CREATE TABLE Tasks (ID TEXT, TITLE TEXT);`;
    const cols = extractStoreColumnsFromSource(source);
    expect(cols.has("tasks")).toBe(true);
    expect(cols.get("tasks")!.has("id")).toBe(true);
    expect(cols.get("tasks")!.has("title")).toBe(true);
  });

  it("returns an empty map for source with no SQL tables", () => {
    const source = `
      // Just a TypeScript file with no SQL
      const x = 42;
      function foo() { return "bar"; }
    `;
    const cols = extractStoreColumnsFromSource(source);
    expect(cols.size).toBe(0);
  });
});

// ── loadSchemaContractRegistry (smoke test) ───────────────────────────────────

describe("loadSchemaContractRegistry", () => {
  it("loads and returns a valid registry with at least one table", () => {
    const registry = loadSchemaContractRegistry();
    expect(registry.version).toBeGreaterThanOrEqual(1);
    expect(registry.tables.length).toBeGreaterThan(0);
    for (const entry of registry.tables) {
      expect(typeof entry.table).toBe("string");
      expect(Array.isArray(entry.canonical_columns)).toBe(true);
      expect(entry.canonical_columns.length).toBeGreaterThan(0);
    }
  });
});
