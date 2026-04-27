import { describe, it, expect } from "vitest";
import {
  detectSchemaChanges,
  detectSchemaContractDrift,
  extractChangedFilesFromDiff,
  buildSchemaImpactNotice,
  buildDownstreamImpactSection,
  SCHEMA_CONSUMER_MAP,
} from "../reviewer/schema-impact.js";
import type { SchemaImpactHit } from "../reviewer/schema-impact.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Builds a minimal git diff for a file with the given content snippet added. */
function makeDiff(filePath: string, addedLines: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,1 +1,5 @@`,
    ...addedLines.split("\n").map((l) => `+${l}`),
  ].join("\n");
}

// ── extractChangedFilesFromDiff ───────────────────────────────────────────────

describe("extractChangedFilesFromDiff", () => {
  it("extracts file paths from git diff headers", () => {
    const diff = makeDiff("src/state/store.ts", "CREATE TABLE tasks (id TEXT);");
    const files = extractChangedFilesFromDiff(diff);
    expect(files).toContain("src/state/store.ts");
  });

  it("extracts multiple files from a multi-file diff", () => {
    const diff = [
      makeDiff("src/state/store.ts", "ALTER TABLE tasks ADD COLUMN foo TEXT;"),
      makeDiff("src/state/types.ts", "export interface Task { foo: string; }"),
    ].join("\n");
    const files = extractChangedFilesFromDiff(diff);
    expect(files).toContain("src/state/store.ts");
    expect(files).toContain("src/state/types.ts");
  });

  it("falls back to +++ b/ lines when git headers are absent", () => {
    const diff = [
      "--- a/src/verifier.ts",
      "+++ b/src/verifier.ts",
      "@@ -1,1 +1,2 @@",
      "+// change",
    ].join("\n");
    const files = extractChangedFilesFromDiff(diff);
    expect(files).toContain("src/verifier.ts");
  });

  it("returns empty array for an empty diff", () => {
    expect(extractChangedFilesFromDiff("")).toEqual([]);
  });

  it("deduplicates repeated file paths", () => {
    const diff = [
      makeDiff("src/state/store.ts", "line 1"),
      makeDiff("src/state/store.ts", "line 2"),
    ].join("\n");
    const files = extractChangedFilesFromDiff(diff);
    expect(files.filter((f) => f === "src/state/store.ts")).toHaveLength(1);
  });
});

// ── detectSchemaChanges ───────────────────────────────────────────────────────

describe("detectSchemaChanges", () => {
  it("detects a state.db schema change (CREATE TABLE)", () => {
    const diff = makeDiff("src/state/store.ts", "CREATE TABLE new_table (id TEXT PRIMARY KEY);");
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toMatch(/state\.db/i);
    expect(hits[0].consumers).toContain("rapartlu/agent-dashboard");
    expect(hits[0].matchedFiles).toContain("src/state/store.ts");
  });

  it("detects an ALTER TABLE as a schema change", () => {
    const diff = makeDiff(
      "src/state/store.ts",
      "ALTER TABLE tasks ADD COLUMN dispatched_at TEXT;",
    );
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].consumers).toContain("rapartlu/agent-orchestrator");
  });

  it("does NOT detect a non-schema change in store.ts (no SQL indicators)", () => {
    const diff = makeDiff("src/state/store.ts", "// refactored helper function");
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files);
    // store.ts has indicators defined — no SQL indicator means no hit
    expect(hits).toHaveLength(0);
  });

  it("detects a state types change (no indicators required)", () => {
    const diff = makeDiff(
      "src/state/types.ts",
      "export interface Task { newField: string; }",
    );
    const files = ["src/state/types.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toMatch(/TypeScript types/i);
  });

  it("detects openapi.yaml change", () => {
    const diff = makeDiff("openapi.yaml", "  /v1/new-endpoint:\n    get:");
    const files = ["openapi.yaml"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toMatch(/OpenAPI/i);
    expect(hits[0].consumers).toContain("rapartlu/agent-dashboard");
  });

  it("detects agents.yaml change", () => {
    const diff = makeDiff("agents.yaml", "  new-agent:\n    port: 3480");
    const files = ["agents.yaml"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].consumers).toContain("rapartlu/agent-proxy");
  });

  it("detects index.ts public API export change", () => {
    const diff = makeDiff("src/index.ts", "export { newHelper } from './reviewer/helpers.js';");
    const files = ["src/index.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toMatch(/public API/i);
    expect(hits[0].consumers).toContain("rapartlu/agent-orchestrator");
  });

  it("returns no hits for a file with no schema pattern match", () => {
    const diff = makeDiff("src/util/logger.ts", "console.log('debug');");
    const files = ["src/util/logger.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(0);
  });

  it("returns no hits for an empty diff", () => {
    const hits = detectSchemaChanges("", []);
    expect(hits).toHaveLength(0);
  });

  it("can return multiple hits when multiple schemas are touched", () => {
    const diff = [
      makeDiff("src/state/store.ts", "CREATE TABLE new_table (id TEXT);"),
      makeDiff("src/state/types.ts", "export interface Task { newField: string; }"),
    ].join("\n");
    const files = ["src/state/store.ts", "src/state/types.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("is case-insensitive for SQL indicators", () => {
    const diff = makeDiff("src/state/store.ts", "create table foo (id text);");
    const files = ["src/state/store.ts"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits).toHaveLength(1);
  });

  it("populates matchedFiles correctly", () => {
    const diff = makeDiff("src/state/store.ts", "ALTER TABLE tasks ADD done INTEGER;");
    const files = ["src/state/store.ts", "README.md"];
    const hits = detectSchemaChanges(diff, files);
    expect(hits[0].matchedFiles).toEqual(["src/state/store.ts"]);
    expect(hits[0].matchedFiles).not.toContain("README.md");
  });
});

// ── buildSchemaImpactNotice ───────────────────────────────────────────────────

describe("buildSchemaImpactNotice", () => {
  it("returns empty string when there are no hits", () => {
    expect(buildSchemaImpactNotice([])).toBe("");
  });

  it("includes the schema label in the output", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema (SQLite tables / columns)",
        consumers: ["rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice).toContain("state.db schema");
  });

  it("includes all consumer repos", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema",
        consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice).toContain("rapartlu/agent-orchestrator");
    expect(notice).toContain("rapartlu/agent-dashboard");
  });

  it("includes the matched file path", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema",
        consumers: ["rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice).toContain("src/state/store.ts");
  });

  it("contains the flagged-risk callout (not a block)", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema",
        consumers: ["rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice).toContain("flagged risk");
    expect(notice).toContain("approve");
  });

  it("renders multiple hits", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema",
        consumers: ["rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
      {
        schemaLabel: "proxy OpenAPI spec",
        consumers: ["rapartlu/agent-orchestrator"],
        matchedFiles: ["openapi.yaml"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice).toContain("state.db schema");
    expect(notice).toContain("proxy OpenAPI spec");
    expect(notice).toContain("openapi.yaml");
  });

  it("starts with a newline so it appends cleanly to the prompt header", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema",
        consumers: ["rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const notice = buildSchemaImpactNotice(hits);
    expect(notice.startsWith("\n")).toBe(true);
  });
});

// ── buildDownstreamImpactSection ──────────────────────────────────────────────

describe("buildDownstreamImpactSection", () => {
  it("returns empty string for no hits", () => {
    const section = buildDownstreamImpactSection([]);
    expect(section).toBe("");
  });

  it("formats a single hit as a collapsible details element", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "state.db schema (SQLite tables / columns)",
        consumers: ["rapartlu/agent-orchestrator", "rapartlu/agent-dashboard"],
        matchedFiles: ["src/state/store.ts"],
      },
    ];
    const section = buildDownstreamImpactSection(hits);
    expect(section).toContain("<details>");
    expect(section).toContain("</details>");
    expect(section).toContain("<summary><b>📦 Downstream Impact</b></summary>");
    expect(section).toContain("rapartlu/agent-orchestrator");
    expect(section).toContain("rapartlu/agent-dashboard");
  });

  it("includes links to consumer repos", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "test schema",
        consumers: ["rapartlu/test-repo"],
        matchedFiles: ["src/test.ts"],
      },
    ];
    const section = buildDownstreamImpactSection(hits);
    expect(section).toContain("https://github.com/rapartlu/test-repo");
  });

  it("lists affected files for each schema", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "test schema",
        consumers: ["rapartlu/test-repo"],
        matchedFiles: ["src/file1.ts", "src/file2.ts"],
      },
    ];
    const section = buildDownstreamImpactSection(hits);
    expect(section).toContain("src/file1.ts");
    expect(section).toContain("src/file2.ts");
  });

  it("groups schemas by consumer", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "schema A",
        consumers: ["rapartlu/shared-repo"],
        matchedFiles: ["src/a.ts"],
      },
      {
        schemaLabel: "schema B",
        consumers: ["rapartlu/shared-repo"],
        matchedFiles: ["src/b.ts"],
      },
      {
        schemaLabel: "schema C",
        consumers: ["rapartlu/other-repo"],
        matchedFiles: ["src/c.ts"],
      },
    ];
    const section = buildDownstreamImpactSection(hits);
    // rapartlu/shared-repo should appear as a link (once in markdown link text, once in URL)
    const sharedRepoMatches = (section.match(/rapartlu\/shared-repo/g) || []).length;
    expect(sharedRepoMatches).toBeGreaterThan(0);
    // but both schemas should be listed
    expect(section).toContain("schema A");
    expect(section).toContain("schema B");
    expect(section).toContain("schema C");
    // and both should be under shared-repo, not duplicated
    const sharedRepoLines = section.split('\n').filter(line => line.includes('shared-repo'));
    expect(sharedRepoLines.length).toBe(1);
  });

  it("starts with a newline so it appends cleanly to comments", () => {
    const hits: SchemaImpactHit[] = [
      {
        schemaLabel: "test",
        consumers: ["rapartlu/test"],
        matchedFiles: ["test.ts"],
      },
    ];
    const section = buildDownstreamImpactSection(hits);
    expect(section.startsWith("\n")).toBe(true);
  });
});

// ── detectSchemaContractDrift ────────────────────────────────────────────────

describe("detectSchemaContractDrift", () => {
  it("detects column-name drift against the contract registry", () => {
    const diff = makeDiff(
      "src/state/store.ts",
      "CREATE TABLE learned_patterns (id TEXT PRIMARY KEY, pattern TEXT NOT NULL, score REAL NOT NULL);",
    );
    const files = ["src/state/store.ts"];
    const hits = detectSchemaContractDrift(diff, files);

    expect(hits).toHaveLength(1);
    expect(hits[0].schemaLabel).toContain("learned_patterns");
    expect(hits[0].contractMismatch).toBe(true);
    expect(hits[0].consumers).toContain("rapartlu/agent-dashboard");
    expect(hits[0].missingColumns).toContain("pattern_name");
    expect(hits[0].extraColumns).toContain("pattern");
  });

  it("formats a contract mismatch into the schema warning notice", () => {
    const diff = makeDiff(
      "src/state/store.ts",
      "ALTER TABLE verification_results ADD COLUMN reviewed_by TEXT;",
    );
    const files = ["src/state/store.ts"];
    const hits = detectSchemaContractDrift(diff, files);
    const notice = buildSchemaImpactNotice(hits);

    expect(notice).toContain("column-name drift detected");
    expect(notice).toContain("verification_results");
    expect(notice).toContain("rapartlu/agent-reviewer");
  });
});

// ── SCHEMA_CONSUMER_MAP sanity checks ─────────────────────────────────────────

describe("SCHEMA_CONSUMER_MAP", () => {
  it("has at least one entry for state.db", () => {
    const entry = SCHEMA_CONSUMER_MAP.find((e) => e.filePattern.includes("state/store"));
    expect(entry).toBeDefined();
    expect(entry!.consumers.length).toBeGreaterThan(0);
  });

  it("every entry has a non-empty schemaLabel", () => {
    for (const entry of SCHEMA_CONSUMER_MAP) {
      expect(entry.schemaLabel.length).toBeGreaterThan(0);
    }
  });

  it("every entry has at least one consumer", () => {
    for (const entry of SCHEMA_CONSUMER_MAP) {
      expect(entry.consumers.length).toBeGreaterThan(0);
    }
  });

  it("every consumer follows owner/repo format", () => {
    for (const entry of SCHEMA_CONSUMER_MAP) {
      for (const consumer of entry.consumers) {
        expect(consumer).toMatch(/^[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/);
      }
    }
  });
});
