/**
 * Tests for merge_conflict_file_history state store methods.
 *
 * Covers: recordMergeConflictFiles, getConflictFrequency
 * These methods feed the reviewer agent's conflict-hot file annotation feature.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateStore } from "./store.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";

describe("merge conflict file history", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `orch-conflict-test-${Date.now()}.db`);
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    try {
      unlinkSync(dbPath);
    } catch {}
  });

  describe("recordMergeConflictFiles", () => {
    it("records conflict events for multiple files", () => {
      store.recordMergeConflictFiles("owner/repo", 42, [
        "src/orchestrator/dispatcher.ts",
        "src/state/store.ts",
      ]);

      const freq = store.getConflictFrequency("owner/repo");
      const files = freq.map((r) => r.filePath);
      expect(files).toContain("src/orchestrator/dispatcher.ts");
      expect(files).toContain("src/state/store.ts");
    });

    it("is a no-op when filePaths is empty", () => {
      store.recordMergeConflictFiles("owner/repo", 1, []);
      expect(store.getConflictFrequency("owner/repo")).toHaveLength(0);
    });

    it("deduplicates events for the same PR + file on the same day", () => {
      store.recordMergeConflictFiles("owner/repo", 7, ["src/foo.ts"]);
      store.recordMergeConflictFiles("owner/repo", 7, ["src/foo.ts"]); // same day, same PR
      store.recordMergeConflictFiles("owner/repo", 7, ["src/foo.ts"]); // again

      const freq = store.getConflictFrequency("owner/repo");
      expect(freq).toHaveLength(1);
      expect(freq[0].count).toBe(1); // deduplicated to one event
    });

    it("counts distinct PR+day combinations separately", () => {
      store.recordMergeConflictFiles("owner/repo", 1, ["src/hot.ts"]);
      store.recordMergeConflictFiles("owner/repo", 2, ["src/hot.ts"]); // different PR → new event

      const freq = store.getConflictFrequency("owner/repo");
      expect(freq).toHaveLength(1);
      expect(freq[0].filePath).toBe("src/hot.ts");
      expect(freq[0].count).toBe(2); // two distinct PRs
    });

    it("isolates results by repo", () => {
      store.recordMergeConflictFiles("owner/repo-a", 1, ["src/shared.ts"]);
      store.recordMergeConflictFiles("owner/repo-b", 2, ["src/shared.ts"]);

      const freqA = store.getConflictFrequency("owner/repo-a");
      expect(freqA).toHaveLength(1);
      expect(freqA[0].count).toBe(1);

      const freqB = store.getConflictFrequency("owner/repo-b");
      expect(freqB).toHaveLength(1);
      expect(freqB[0].count).toBe(1);
    });
  });

  describe("getConflictFrequency", () => {
    it("returns results sorted by count descending", () => {
      store.recordMergeConflictFiles("owner/repo", 1, ["src/hot.ts", "src/cold.ts"]);
      store.recordMergeConflictFiles("owner/repo", 2, ["src/hot.ts"]); // hot gets 2 events

      const freq = store.getConflictFrequency("owner/repo");
      expect(freq[0].filePath).toBe("src/hot.ts");
      expect(freq[0].count).toBe(2);
      expect(freq[1].filePath).toBe("src/cold.ts");
      expect(freq[1].count).toBe(1);
    });

    it("respects minCount filter", () => {
      store.recordMergeConflictFiles("owner/repo", 1, ["src/once.ts"]);
      store.recordMergeConflictFiles("owner/repo", 2, ["src/twice.ts"]);
      store.recordMergeConflictFiles("owner/repo", 3, ["src/twice.ts"]);

      const freq = store.getConflictFrequency("owner/repo", 30, 2);
      expect(freq).toHaveLength(1);
      expect(freq[0].filePath).toBe("src/twice.ts");
    });

    it("returns empty array when no conflicts recorded", () => {
      expect(store.getConflictFrequency("owner/repo")).toHaveLength(0);
    });

    it("includes lastConflictAt timestamp", () => {
      store.recordMergeConflictFiles("owner/repo", 1, ["src/foo.ts"]);
      const freq = store.getConflictFrequency("owner/repo");
      expect(freq[0].lastConflictAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });
});
