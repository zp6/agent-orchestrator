import { describe, it, expect, afterEach } from "vitest";
import Database from "better-sqlite3";
import { tmpdir } from "os";
import { join } from "path";
import { rmSync, existsSync } from "fs";
import {
  SchemaConsumerRegistry,
  getSchemaConsumersApiPayload,
} from "../reviewer/schema-consumer-registry.js";
import { detectSchemaChanges } from "../reviewer/schema-impact.js";
import { SCHEMA_CONSUMER_MAP } from "../reviewer/schema-impact.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Create a temporary in-memory-like SQLite db with a known schema. */
function makeTempDb(suffix: string): { dbPath: string; db: Database.Database } {
  const dbPath = join(tmpdir(), `test-registry-${suffix}-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE pr_reviews (id TEXT PRIMARY KEY, repo TEXT NOT NULL);
    CREATE TABLE merge_queue (repo TEXT NOT NULL, pr_number INTEGER NOT NULL);
    CREATE TABLE supervisor_decisions (id TEXT PRIMARY KEY, action TEXT NOT NULL);
    CREATE TABLE verification_results (id INTEGER PRIMARY KEY, score REAL NOT NULL);
    CREATE TABLE llm_call_events (id INTEGER PRIMARY KEY, call_type TEXT NOT NULL);
    CREATE TABLE schema_table_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name TEXT NOT NULL,
      call_type TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(table_name, call_type)
    );
  `);
  return { dbPath, db };
}

function cleanupDb(dbPath: string, db: Database.Database): void {
  db.close();
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });
}

/** Minimal git diff for a file with added content. */
function makeDiff(filePath: string, addedLine: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,1 +1,2 @@`,
    `+${addedLine}`,
  ].join("\n");
}

// ── SchemaConsumerRegistry ────────────────────────────────────────────────────

describe("SchemaConsumerRegistry.discoverTables", () => {
  it("returns table names from a populated database", () => {
    const { dbPath, db } = makeTempDb("discover");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const tables = registry.discoverTables();
      registry.close();

      expect(tables).toContain("tasks");
      expect(tables).toContain("pr_reviews");
      expect(tables).toContain("merge_queue");
      expect(tables).toContain("supervisor_decisions");
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("excludes sqlite_ internal tables", () => {
    const { dbPath, db } = makeTempDb("internals");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const tables = registry.discoverTables();
      registry.close();

      expect(tables.every((t) => !t.startsWith("sqlite_"))).toBe(true);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("returns empty array when database does not exist", () => {
    const registry = new SchemaConsumerRegistry("/tmp/nonexistent-state-test.db");
    const tables = registry.discoverTables();
    registry.close();
    expect(tables).toEqual([]);
  });
});

// ── buildDynamicEntries ───────────────────────────────────────────────────────

describe("SchemaConsumerRegistry.buildDynamicEntries", () => {
  it("returns one entry per table", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["tasks", "pr_reviews", "merge_queue"]);
    registry.close();
    expect(entries).toHaveLength(3);
  });

  it("uses state/store as filePattern for all DB table entries", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["tasks"]);
    registry.close();
    expect(entries[0].filePattern).toBe("state/store");
  });

  it("includes the table name in schemaLabel", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["my_table"]);
    registry.close();
    expect(entries[0].schemaLabel).toContain("my_table");
  });

  it("assigns orchestrator + dashboard consumers to task table", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["tasks"]);
    registry.close();
    expect(entries[0].consumers).toContain("rapartlu/agent-orchestrator");
    expect(entries[0].consumers).toContain("rapartlu/agent-dashboard");
  });

  it("assigns reviewer to verification_results table", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["verification_results"]);
    registry.close();
    expect(entries[0].consumers).toContain("rapartlu/agent-reviewer");
  });

  it("assigns dashboard-only to llm_call_events table", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["llm_call_events"]);
    registry.close();
    expect(entries[0].consumers).toContain("rapartlu/agent-dashboard");
  });

  it("generates SQL indicator patterns for the table name", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["tasks"]);
    registry.close();
    const indicators = entries[0].indicators ?? [];
    expect(indicators.some((i) => i.includes("tasks"))).toBe(true);
  });

  it("returns a conservative default for unknown table names", () => {
    const registry = new SchemaConsumerRegistry(":memory:");
    const entries = registry.buildDynamicEntries(["xyzzy_unknown_table"]);
    registry.close();
    expect(entries[0].consumers).toContain("rapartlu/agent-orchestrator");
    expect(entries[0].consumers).toContain("rapartlu/agent-dashboard");
  });
});

// ── getConsumerMap ────────────────────────────────────────────────────────────

describe("SchemaConsumerRegistry.getConsumerMap", () => {
  it("merges dynamic entries before static SCHEMA_CONSUMER_MAP entries", () => {
    const { dbPath, db } = makeTempDb("merge");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const map = registry.getConsumerMap();
      registry.close();

      // Dynamic entries come first (file pattern = "state/store", label contains table name)
      const dynamicEntry = map.find((e) => e.schemaLabel.startsWith("state.db table:"));
      const staticEntry = map.find((e) => e.schemaLabel === "state.db schema (SQLite tables / columns)");

      expect(dynamicEntry).toBeDefined();
      expect(staticEntry).toBeDefined();
      expect(map.indexOf(dynamicEntry!)).toBeLessThan(map.indexOf(staticEntry!));
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("falls back to static SCHEMA_CONSUMER_MAP when DB is unreachable", () => {
    const registry = new SchemaConsumerRegistry("/tmp/missing-db-registry-test.db");
    const map = registry.getConsumerMap();
    registry.close();

    // Should return the static entries unchanged
    expect(map).toEqual(SCHEMA_CONSUMER_MAP);
  });

  it("includes non-DB static entries (agents.yaml, openapi.yaml) even with a live DB", () => {
    const { dbPath, db } = makeTempDb("static-entries");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const map = registry.getConsumerMap();
      registry.close();

      const agentsEntry = map.find((e) => e.filePattern === "agents.yaml");
      const openapiEntry = map.find((e) => e.filePattern === "openapi.yaml");
      expect(agentsEntry).toBeDefined();
      expect(openapiEntry).toBeDefined();
    } finally {
      cleanupDb(dbPath, db);
    }
  });
});

// ── getAccessLog ──────────────────────────────────────────────────────────────

describe("SchemaConsumerRegistry.getAccessLog", () => {
  it("returns empty array when schema_table_access table has no rows", () => {
    const { dbPath, db } = makeTempDb("access-empty");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const log = registry.getAccessLog();
      registry.close();
      expect(log).toEqual([]);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("returns rows inserted by StateStore.recordTableAccess()", () => {
    const { dbPath, db } = makeTempDb("access-rows");
    // Insert a row directly to simulate StateStore instrumentation
    db.prepare(
      `INSERT INTO schema_table_access (table_name, call_type, access_count, last_seen_at)
       VALUES (?, ?, ?, datetime('now'))`,
    ).run("tasks", "pr-review", 42);

    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const log = registry.getAccessLog();
      registry.close();

      expect(log).toHaveLength(1);
      expect(log[0].table_name).toBe("tasks");
      expect(log[0].call_type).toBe("pr-review");
      expect(log[0].access_count).toBe(42);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("returns empty array when schema_table_access table does not exist", () => {
    const dbPath = join(tmpdir(), `test-registry-no-table-${Date.now()}.db`);
    const db = new Database(dbPath);
    // Create a DB without the schema_table_access table
    db.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const log = registry.getAccessLog();
      registry.close();
      expect(log).toEqual([]);
    } finally {
      cleanupDb(dbPath, db);
    }
  });
});

// ── toApiPayload ──────────────────────────────────────────────────────────────

describe("SchemaConsumerRegistry.toApiPayload", () => {
  it("returns dynamic source when DB has tables", () => {
    const { dbPath, db } = makeTempDb("payload-dynamic");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const payload = registry.toApiPayload();
      registry.close();
      expect(payload.source).toBe("dynamic");
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("returns static-fallback source when DB is unreachable", () => {
    const registry = new SchemaConsumerRegistry("/tmp/payload-missing-db.db");
    const payload = registry.toApiPayload();
    registry.close();
    expect(payload.source).toBe("static-fallback");
  });

  it("includes generated_at ISO timestamp", () => {
    const { dbPath, db } = makeTempDb("payload-timestamp");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const payload = registry.toApiPayload();
      registry.close();
      expect(() => new Date(payload.generated_at)).not.toThrow();
      expect(new Date(payload.generated_at).getFullYear()).toBeGreaterThan(2020);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("includes all three output sections", () => {
    const { dbPath, db } = makeTempDb("payload-sections");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const payload = registry.toApiPayload();
      registry.close();
      expect(Array.isArray(payload.db_tables)).toBe(true);
      expect(Array.isArray(payload.discovered_entries)).toBe(true);
      expect(Array.isArray(payload.static_entries)).toBe(true);
      expect(Array.isArray(payload.access_log)).toBe(true);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("db_tables matches discovered table names", () => {
    const { dbPath, db } = makeTempDb("payload-tables");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const payload = registry.toApiPayload();
      registry.close();
      expect(payload.db_tables).toContain("tasks");
      expect(payload.db_tables).toContain("pr_reviews");
    } finally {
      cleanupDb(dbPath, db);
    }
  });
});

// ── getSchemaConsumersApiPayload ──────────────────────────────────────────────

describe("getSchemaConsumersApiPayload", () => {
  it("returns a payload with static_entries equal to SCHEMA_CONSUMER_MAP", () => {
    const payload = getSchemaConsumersApiPayload("/tmp/payload-api-missing.db");
    expect(payload.static_entries).toEqual(SCHEMA_CONSUMER_MAP);
  });

  it("closes the DB connection automatically", () => {
    // Calling twice should not throw (fresh registry per call)
    expect(() => {
      getSchemaConsumersApiPayload("/tmp/payload-api-idempotent.db");
      getSchemaConsumersApiPayload("/tmp/payload-api-idempotent.db");
    }).not.toThrow();
  });
});

// ── detectSchemaChanges with custom consumerMap ───────────────────────────────

describe("detectSchemaChanges with custom consumerMap from registry", () => {
  it("uses the provided consumerMap when detecting changes", () => {
    const customMap = [
      {
        filePattern: "my-custom-schema",
        schemaLabel: "Custom Schema",
        consumers: ["rapartlu/custom-repo"],
      },
    ];

    const diff = makeDiff("src/my-custom-schema.ts", "// change");
    const files = ["src/my-custom-schema.ts"];
    const hits = detectSchemaChanges(diff, files, customMap);

    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toBe("Custom Schema");
    expect(hits[0].consumers).toContain("rapartlu/custom-repo");
  });

  it("falls back to SCHEMA_CONSUMER_MAP when no consumerMap provided", () => {
    const diff = makeDiff("src/state/store.ts", "CREATE TABLE tasks (id TEXT);");
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files);

    // Default map should detect this
    expect(hits.length).toBeGreaterThan(0);
  });

  it("uses live-discovered entries from registry", () => {
    const { dbPath, db } = makeTempDb("detect-live");
    try {
      const registry = new SchemaConsumerRegistry(dbPath);
      const liveMap = registry.getConsumerMap();
      registry.close();

      // The registry creates an entry for every discovered table with indicator patterns
      // Check that a state/store change with ALTER TABLE tasks is detected
      const diff = makeDiff("src/state/store.ts", "ALTER TABLE tasks ADD COLUMN foo TEXT;");
      const files = ["src/state/store.ts"];
      const hits = detectSchemaChanges(diff, files, liveMap);

      // Should match the dynamic "tasks" entry or the static state.db entry
      expect(hits.length).toBeGreaterThan(0);
    } finally {
      cleanupDb(dbPath, db);
    }
  });

  it("custom map with empty array produces no hits", () => {
    const diff = makeDiff("src/state/store.ts", "CREATE TABLE tasks (id TEXT);");
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files, []);
    expect(hits).toHaveLength(0);
  });
});
