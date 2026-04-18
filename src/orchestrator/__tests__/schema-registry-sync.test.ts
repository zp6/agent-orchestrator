import { describe, it, expect, vi, beforeEach } from "vitest";
import { SchemaRegistrySyncDetector } from "../schema-registry-sync.js";
import type { OrchestratorConfig } from "../../config/schema.js";
import type { StateStore } from "../../state/store.js";
import type { IssueCreator } from "../issue-creator.js";

// Mock implementations
const mockIssueCreator = {
  createIssue: vi.fn(),
  getOpenOrchestratorIssueCount: vi.fn().mockReturnValue(0),
  isDuplicate: vi.fn().mockReturnValue(false),
} as unknown as IssueCreator;

const mockConfig: OrchestratorConfig = {
  github: { repo: "rapartlu/agent-orchestrator" },
  agents: {},
} as unknown as OrchestratorConfig;

const mockStore = {} as unknown as StateStore;

describe("SchemaRegistrySyncDetector", () => {
  let detector: SchemaRegistrySyncDetector;

  beforeEach(() => {
    vi.clearAllMocks();
    detector = new SchemaRegistrySyncDetector(mockConfig, mockStore, mockIssueCreator);
  });

  describe("extractSchemaRegistryFromDiff", () => {
    it("should extract old and new registry by including context lines in both", () => {
      // Realistic unified diff: context lines (space prefix) must go to both old and new,
      // otherwise neither string is valid JSON.
      const diff = `diff --git a/src/config/schema-registry.json b/src/config/schema-registry.json
index abc123..def456 100644
--- a/src/config/schema-registry.json
+++ b/src/config/schema-registry.json
@@ -1,10 +1,10 @@
 {
   "version": 1,
   "description": "Schema registry",
   "tables": [
     {
       "table": "tasks",
       "writer_repo": "repo-a",
       "consumer_repos": ["repo-b"],
-      "canonical_columns": ["id", "title"]
+      "canonical_columns": ["id", "title", "status"]
     }
   ]
 }`;

      const result = (detector as any).extractSchemaRegistryFromDiff(diff);
      expect(result).not.toBeNull();
      expect(result.old.tables[0].canonical_columns).toEqual(["id", "title"]);
      expect(result.new.tables[0].canonical_columns).toEqual(["id", "title", "status"]);
    });

    it("should return null when schema-registry.json is not in the diff", () => {
      const diff = `diff --git a/src/other-file.txt b/src/other-file.txt
index abc123..def456 100644
--- a/src/other-file.txt
+++ b/src/other-file.txt
@@ -1 +1 @@
-old content
+new content`;

      const result = (detector as any).extractSchemaRegistryFromDiff(diff);
      expect(result).toBeNull();
    });
  });

  describe("computeTableChanges", () => {
    it("should detect added columns", () => {
      const oldRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id", "title"],
          },
        ],
      };

      const newRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id", "title", "status"],
          },
        ],
      };

      // Access private method via any for testing
      const detector = new SchemaRegistrySyncDetector(mockConfig, mockStore, mockIssueCreator);
      const changes = (detector as any).computeTableChanges(oldRegistry, newRegistry);

      expect(changes).toHaveLength(1);
      expect(changes[0].table).toBe("tasks");
      expect(changes[0].added).toContain("status");
      expect(changes[0].removed).toHaveLength(0);
    });

    it("should detect removed columns", () => {
      const oldRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id", "title", "description"],
          },
        ],
      };

      const newRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id", "title"],
          },
        ],
      };

      const detector = new SchemaRegistrySyncDetector(mockConfig, mockStore, mockIssueCreator);
      const changes = (detector as any).computeTableChanges(oldRegistry, newRegistry);

      expect(changes).toHaveLength(1);
      expect(changes[0].removed).toContain("description");
      expect(changes[0].added).toHaveLength(0);
    });

    it("should detect added tables", () => {
      const oldRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id"],
          },
        ],
      };

      const newRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "tasks",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b"],
            canonical_columns: ["id"],
          },
          {
            table: "learned_patterns",
            writer_repo: "repo-a",
            consumer_repos: ["repo-b", "repo-c"],
            canonical_columns: ["id", "pattern"],
          },
        ],
      };

      const detector = new SchemaRegistrySyncDetector(mockConfig, mockStore, mockIssueCreator);
      const changes = (detector as any).computeTableChanges(oldRegistry, newRegistry);

      expect(changes).toHaveLength(1);
      expect(changes[0].table).toBe("learned_patterns");
      expect(changes[0].consumersAffected).toContain("repo-b");
      expect(changes[0].consumersAffected).toContain("repo-c");
    });

    it("should skip tables with no consumers", () => {
      const oldRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "internal_logs",
            writer_repo: "repo-a",
            consumer_repos: [],
            canonical_columns: ["id"],
          },
        ],
      };

      const newRegistry = {
        version: 1,
        description: "Test",
        tables: [
          {
            table: "internal_logs",
            writer_repo: "repo-a",
            consumer_repos: [],
            canonical_columns: ["id", "message"],
          },
        ],
      };

      const detector = new SchemaRegistrySyncDetector(mockConfig, mockStore, mockIssueCreator);
      const changes = (detector as any).computeTableChanges(oldRegistry, newRegistry);

      // Table changed but has no consumers, so no notification
      expect(changes).toHaveLength(0);
    });
  });

  describe("formatSchemaChangeBody", () => {
    it("should format issue body with schema changes", () => {
      const delta = {
        orchestratorPRNumber: 850,
        orchestratorPRRepo: "rapartlu/agent-orchestrator",
        changedTables: [
          {
            table: "tasks",
            oldColumns: ["id", "title"],
            newColumns: ["id", "title", "status"],
            added: ["status"],
            removed: [],
            consumersAffected: ["repo-b"],
          },
        ],
      };

      const body = (detector as any).formatSchemaChangeBody(
        delta,
        850,
        "rapartlu/agent-orchestrator",
      );

      expect(body).toContain("Schema Contract Updated");
      expect(body).toContain("tasks");
      expect(body).toContain("status");
      expect(body).toContain("rapartlu/agent-orchestrator#850");
    });

    it("should format body with both added and removed columns", () => {
      const delta = {
        orchestratorPRNumber: 851,
        orchestratorPRRepo: "rapartlu/agent-orchestrator",
        changedTables: [
          {
            table: "learned_patterns",
            oldColumns: ["id", "pattern_type", "title"],
            newColumns: ["id", "pattern_name", "title"],
            added: ["pattern_name"],
            removed: ["pattern_type"],
            consumersAffected: ["repo-b", "repo-c"],
          },
        ],
      };

      const body = (detector as any).formatSchemaChangeBody(
        delta,
        851,
        "rapartlu/agent-orchestrator",
      );

      expect(body).toContain("pattern_type");
      expect(body).toContain("pattern_name");
    });
  });
});
