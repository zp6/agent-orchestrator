import { describe, it, expect } from "vitest";
import {
  detectSchemaContractDrift,
  buildSchemaContractNotice,
  extractChangedFiles,
  loadSchemaRegistry,
  type SchemaRegistry,
  type SchemaContractHit,
} from "./schema-impact.js";

// ── Test registry (in-memory, not reading the JSON file) ──────────────────

const TEST_REGISTRY: SchemaRegistry = {
  version: 1,
  tables: [
    {
      table: "learned_patterns",
      writer_repo: "rapartlu/agent-orchestrator",
      consumer_repos: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
      canonical_columns: [
        "id",
        "pattern_type",
        "title",
        "description",
        "source",
        "source_ref",
        "agent",
        "repos",
        "confidence",
        "hit_count",
        "first_pass_saves",
        "active",
        "suppressed_at",
        "promoted_at",
        "created_at",
        "updated_at",
      ],
      notes: "Immune-system anti-pattern registry.",
    },
    {
      table: "routing_decisions",
      writer_repo: "rapartlu/agent-orchestrator",
      consumer_repos: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
      canonical_columns: [
        "id",
        "action",
        "agent_name",
        "reason",
        "message",
        "outcome",
        "task_id",
        "route_method",
        "redirect_reason",
        "created_at",
      ],
    },
    {
      table: "tasks",
      writer_repo: "rapartlu/agent-orchestrator",
      consumer_repos: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
      canonical_columns: [
        "id",
        "title",
        "description",
        "status",
        "agent_name",
        "created_at",
        "updated_at",
      ],
    },
  ],
};

// ── Helpers ───────────────────────────────────────────────────────────────

function makeDiff(addedLines: string[]): string {
  return [
    "diff --git a/src/state/store.ts b/src/state/store.ts",
    "--- a/src/state/store.ts",
    "+++ b/src/state/store.ts",
    "@@ -1,0 +1,10 @@",
    ...addedLines.map((l) => `+${l}`),
  ].join("\n");
}

// ── extractChangedFiles ───────────────────────────────────────────────────

describe("extractChangedFiles", () => {
  it("parses git diff headers", () => {
    const diff = [
      "diff --git a/src/state/store.ts b/src/state/store.ts",
      "diff --git a/src/config/schema.ts b/src/config/schema.ts",
    ].join("\n");
    const files = extractChangedFiles(diff);
    expect(files).toContain("src/state/store.ts");
    expect(files).toContain("src/config/schema.ts");
  });

  it("falls back to +++ b/ lines when no git headers", () => {
    const diff = [
      "--- a/src/state/store.ts",
      "+++ b/src/state/store.ts",
    ].join("\n");
    expect(extractChangedFiles(diff)).toContain("src/state/store.ts");
  });

  it("deduplicates files", () => {
    const diff = [
      "diff --git a/src/state/store.ts b/src/state/store.ts",
      "diff --git a/src/state/store.ts b/src/state/store.ts",
    ].join("\n");
    expect(extractChangedFiles(diff)).toHaveLength(1);
  });
});

// ── detectSchemaContractDrift ─────────────────────────────────────────────

describe("detectSchemaContractDrift", () => {
  describe("CREATE TABLE — matching canonical columns", () => {
    it("returns no hits when columns match the registry exactly", () => {
      const diff = makeDiff([
        "CREATE TABLE IF NOT EXISTS learned_patterns (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  pattern_type TEXT NOT NULL,",
        "  title TEXT NOT NULL,",
        "  description TEXT NOT NULL,",
        "  source TEXT NOT NULL,",
        "  source_ref TEXT,",
        "  agent TEXT,",
        "  repos TEXT,",
        "  confidence REAL NOT NULL,",
        "  hit_count INTEGER NOT NULL,",
        "  first_pass_saves INTEGER NOT NULL,",
        "  active INTEGER NOT NULL,",
        "  suppressed_at TEXT,",
        "  promoted_at TEXT,",
        "  created_at TEXT NOT NULL,",
        "  updated_at TEXT NOT NULL",
        ");",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      const driftHits = hits.filter((h) => h.contractMismatch);
      expect(driftHits).toHaveLength(0);
    });
  });

  describe("CREATE TABLE — mismatched column names (the 01KP654X bug)", () => {
    it("detects drift when PR uses wrong column names for learned_patterns", () => {
      // This is the actual bug: dashboard reads pattern_type/title/description
      // but the PR introduces pattern_name/pattern_value/source_repo instead.
      const diff = makeDiff([
        "CREATE TABLE IF NOT EXISTS learned_patterns (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  pattern_name TEXT NOT NULL,",
        "  pattern_value TEXT NOT NULL,",
        "  source_repo TEXT NOT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      const driftHits = hits.filter((h) => h.contractMismatch);
      expect(driftHits).toHaveLength(1);
      expect(driftHits[0].table).toBe("learned_patterns");
      expect(driftHits[0].consumers).toContain("rapartlu/agent-dashboard");
    });

    it("reports the extra columns introduced by the PR", () => {
      const diff = makeDiff([
        "CREATE TABLE IF NOT EXISTS learned_patterns (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  pattern_name TEXT NOT NULL,",
        "  pattern_value TEXT NOT NULL,",
        "  source_repo TEXT NOT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
      ]);
      const [hit] = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY).filter(
        (h) => h.contractMismatch,
      );
      expect(hit.extraColumns).toContain("pattern_name");
      expect(hit.extraColumns).toContain("pattern_value");
      expect(hit.extraColumns).toContain("source_repo");
    });

    it("reports columns missing from the PR relative to the registry", () => {
      const diff = makeDiff([
        "CREATE TABLE IF NOT EXISTS learned_patterns (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  pattern_name TEXT NOT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
      ]);
      const [hit] = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY).filter(
        (h) => h.contractMismatch,
      );
      // Many registry columns are missing
      expect(hit.missingColumns).toContain("pattern_type");
      expect(hit.missingColumns).toContain("title");
      expect(hit.missingColumns).toContain("description");
    });
  });

  describe("ALTER TABLE ADD COLUMN", () => {
    it("does not flag a drift hit when the new column is in the registry", () => {
      const diff = makeDiff([
        "ALTER TABLE learned_patterns ADD COLUMN suppressed_at TEXT;",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      const driftHits = hits.filter((h) => h.contractMismatch);
      expect(driftHits).toHaveLength(0);
    });

    it("flags drift when the new column is NOT in the registry", () => {
      const diff = makeDiff([
        "ALTER TABLE learned_patterns ADD COLUMN unknown_column TEXT;",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      const driftHits = hits.filter((h) => h.contractMismatch);
      expect(driftHits).toHaveLength(1);
      expect(driftHits[0].extraColumns).toContain("unknown_column");
    });
  });

  describe("INSERT INTO", () => {
    it("flags drift when INSERT references a column not in the registry", () => {
      const diff = makeDiff([
        "INSERT INTO routing_decisions (action, agent_name, pattern_name, created_at) VALUES (?, ?, ?, ?);",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      const driftHits = hits.filter((h) => h.contractMismatch);
      expect(driftHits).toHaveLength(1);
      expect(driftHits[0].table).toBe("routing_decisions");
      expect(driftHits[0].extraColumns).toContain("pattern_name");
    });

    it("does not flag drift when all INSERT columns are in the registry", () => {
      const diff = makeDiff([
        "INSERT INTO routing_decisions (action, agent_name, outcome, created_at) VALUES (?, ?, ?, ?);",
      ]);
      const hits = detectSchemaContractDrift(diff, ["src/state/store.ts"], TEST_REGISTRY);
      expect(hits.filter((h) => h.contractMismatch)).toHaveLength(0);
    });
  });

  describe("unknown tables", () => {
    it("does not flag tables not in the registry", () => {
      const diff = makeDiff([
        "CREATE TABLE IF NOT EXISTS unknown_table (",
        "  id INTEGER PRIMARY KEY,",
        "  foo TEXT",
        ");",
      ]);
      const hits = detectSchemaContractDrift(diff, [], TEST_REGISTRY);
      expect(hits).toHaveLength(0);
    });
  });

  describe("deduplication", () => {
    it("returns one hit per unique table+column-delta even with repeated statements", () => {
      const addedLine =
        "CREATE TABLE IF NOT EXISTS learned_patterns (id INTEGER PRIMARY KEY, pattern_name TEXT NOT NULL, created_at TEXT NOT NULL);";
      const diff = makeDiff([addedLine, addedLine]);
      const hits = detectSchemaContractDrift(diff, [], TEST_REGISTRY);
      const uniqueTables = new Set(hits.map((h) => h.table));
      expect(uniqueTables.size).toBe(1);
    });
  });
});

// ── buildSchemaContractNotice ─────────────────────────────────────────────

describe("buildSchemaContractNotice", () => {
  it("returns empty string when no drift hits", () => {
    const cleanHit: SchemaContractHit = {
      schemaLabel: "schema contract: learned_patterns",
      table: "learned_patterns",
      consumers: ["rapartlu/agent-dashboard"],
      matchedFiles: ["src/state/store.ts"],
      contractMismatch: false,
      canonicalColumns: ["id", "title"],
      observedColumns: ["id", "title"],
      missingColumns: [],
      extraColumns: [],
    };
    expect(buildSchemaContractNotice([cleanHit])).toBe("");
  });

  it("returns a warning when there is a drift hit", () => {
    const driftHit: SchemaContractHit = {
      schemaLabel: "schema contract: learned_patterns",
      table: "learned_patterns",
      consumers: ["rapartlu/agent-dashboard"],
      matchedFiles: ["src/state/store.ts"],
      contractMismatch: true,
      canonicalColumns: ["id", "pattern_type", "title"],
      observedColumns: ["id", "pattern_name"],
      missingColumns: ["pattern_type", "title"],
      extraColumns: ["pattern_name"],
    };
    const notice = buildSchemaContractNotice([driftHit]);
    expect(notice).toContain("Schema Contract Registry");
    expect(notice).toContain("learned_patterns");
    expect(notice).toContain("rapartlu/agent-dashboard");
    expect(notice).toContain("pattern_type");
    expect(notice).toContain("pattern_name");
  });

  it("includes notes from the registry entry when present", () => {
    const driftHit: SchemaContractHit = {
      schemaLabel: "schema contract: learned_patterns",
      table: "learned_patterns",
      consumers: ["rapartlu/agent-dashboard"],
      matchedFiles: [],
      contractMismatch: true,
      canonicalColumns: ["id", "pattern_type"],
      observedColumns: ["id", "pattern_name"],
      missingColumns: ["pattern_type"],
      extraColumns: ["pattern_name"],
      notes: "Immune-system anti-pattern registry.",
    };
    const notice = buildSchemaContractNotice([driftHit]);
    expect(notice).toContain("Immune-system anti-pattern registry.");
  });

  it("mentions the schema-registry.json update instruction", () => {
    const driftHit: SchemaContractHit = {
      schemaLabel: "schema contract: tasks",
      table: "tasks",
      consumers: ["rapartlu/agent-dashboard"],
      matchedFiles: [],
      contractMismatch: true,
      canonicalColumns: ["id", "status"],
      observedColumns: ["id", "state"],
      missingColumns: ["status"],
      extraColumns: ["state"],
    };
    const notice = buildSchemaContractNotice([driftHit]);
    expect(notice).toContain("schema-registry.json");
  });
});

// ── loadSchemaRegistry (smoke test against the real file) ─────────────────

describe("loadSchemaRegistry (real file)", () => {
  it("loads and validates the checked-in schema-registry.json", () => {
    // Will throw if the file is missing or malformed
    const registry = loadSchemaRegistry();
    expect(registry.version).toBe(1);
    expect(Array.isArray(registry.tables)).toBe(true);
    expect(registry.tables.length).toBeGreaterThan(0);
  });

  it("includes the learned_patterns table with correct columns", () => {
    const registry = loadSchemaRegistry();
    const entry = registry.tables.find((t) => t.table === "learned_patterns");
    expect(entry).toBeDefined();
    // Must include the canonical columns that caused the 01KP654X bug
    expect(entry!.canonical_columns).toContain("pattern_type");
    expect(entry!.canonical_columns).toContain("title");
    expect(entry!.canonical_columns).toContain("description");
    expect(entry!.canonical_columns).toContain("confidence");
    expect(entry!.canonical_columns).toContain("hit_count");
    // Must NOT include the wrong column names from the old registry
    expect(entry!.canonical_columns).not.toContain("pattern_name");
    expect(entry!.canonical_columns).not.toContain("pattern_value");
    expect(entry!.canonical_columns).not.toContain("source_repo");
  });

  it("has consumer repos for learned_patterns including the dashboard", () => {
    const registry = loadSchemaRegistry();
    const entry = registry.tables.find((t) => t.table === "learned_patterns");
    expect(entry!.consumer_repos).toContain("rapartlu/agent-dashboard");
  });

  it("includes routing_decisions with canonical columns", () => {
    const registry = loadSchemaRegistry();
    const entry = registry.tables.find((t) => t.table === "routing_decisions");
    expect(entry).toBeDefined();
    expect(entry!.canonical_columns).toContain("action");
    expect(entry!.canonical_columns).toContain("agent_name");
    expect(entry!.canonical_columns).toContain("outcome");
    expect(entry!.canonical_columns).toContain("route_method");
  });
});
