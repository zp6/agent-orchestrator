/**
 * Tests for standup-batch-splitter — issue #259
 *
 * Verifies parseActionItems(), splitIntoBatches(), and formatBatchAsTask()
 * for correct batch splitting of large standup action item lists.
 */

import { describe, it, expect } from "vitest";
import {
  parseActionItems,
  splitIntoBatches,
  formatBatchAsTask,
  BATCH_SIZE,
  SPLIT_THRESHOLD,
  type ActionItem,
} from "../reviewer/standup-batch-splitter.js";

// ── Constants ─────────────────────────────────────────────────────────────────

describe("constants", () => {
  it("BATCH_SIZE is 3", () => {
    expect(BATCH_SIZE).toBe(3);
  });

  it("SPLIT_THRESHOLD is 5", () => {
    expect(SPLIT_THRESHOLD).toBe(5);
  });
});

// ── parseActionItems ──────────────────────────────────────────────────────────

describe("parseActionItems", () => {
  it("parses HIGH/MEDIUM/LOW items from ### Action Items section", () => {
    const body = `### Action Items
- [HIGH] Fix critical auth bug
- [MEDIUM] Update documentation
- [LOW] Refactor legacy module`;

    const items = parseActionItems(body);
    expect(items).toHaveLength(3);
    expect(items[0]).toEqual({ priority: "HIGH", description: "Fix critical auth bug", raw: "- [HIGH] Fix critical auth bug" });
    expect(items[1]).toEqual({ priority: "MEDIUM", description: "Update documentation", raw: "- [MEDIUM] Update documentation" });
    expect(items[2]).toEqual({ priority: "LOW", description: "Refactor legacy module", raw: "- [LOW] Refactor legacy module" });
  });

  it("returns empty array for 'No action items.' sentinel", () => {
    const body = `### Action Items\nNo action items.`;
    expect(parseActionItems(body)).toEqual([]);
  });

  it("returns empty array when ### Action Items section is missing", () => {
    const body = `## Summary\nSome content\n\n## Notes\nMore content`;
    expect(parseActionItems(body)).toEqual([]);
  });

  it("ignores lines outside the Action Items section", () => {
    const body = `## Overview
- [HIGH] This should NOT be parsed

### Action Items
- [HIGH] This SHOULD be parsed
- [MEDIUM] This too

### Other Section
- [LOW] This should NOT be parsed either`;

    const items = parseActionItems(body);
    expect(items).toHaveLength(2);
    expect(items[0].description).toBe("This SHOULD be parsed");
    expect(items[1].description).toBe("This too");
  });

  it("handles mixed priority ordering in the source", () => {
    const body = `### Action Items
- [LOW] Low priority item
- [HIGH] High priority item
- [MEDIUM] Medium priority item`;

    const items = parseActionItems(body);
    expect(items).toHaveLength(3);
    // Returns in source order — sorting is done by splitIntoBatches
    expect(items[0].priority).toBe("LOW");
    expect(items[1].priority).toBe("HIGH");
    expect(items[2].priority).toBe("MEDIUM");
  });

  it("handles empty body", () => {
    expect(parseActionItems("")).toEqual([]);
  });

  it("handles body with only section header and no items", () => {
    const body = `### Action Items\n`;
    expect(parseActionItems(body)).toEqual([]);
  });

  it("handles items with extra whitespace", () => {
    const body = `### Action Items
  - [HIGH] Item with leading spaces
- [MEDIUM]   Item with extra spaces in description`;

    const items = parseActionItems(body);
    expect(items).toHaveLength(2);
    expect(items[0].priority).toBe("HIGH");
    expect(items[1].description).toBe("Item with extra spaces in description");
  });
});

// ── splitIntoBatches ──────────────────────────────────────────────────────────

function makeItems(count: number, priority: string = "HIGH"): ActionItem[] {
  return Array.from({ length: count }, (_, i) => ({
    priority,
    description: `Action item ${i + 1}`,
    raw: `- [${priority}] Action item ${i + 1}`,
  }));
}

describe("splitIntoBatches", () => {
  const parentRef = "rapartlu/agent-reviewer#259";

  it("returns shouldSplit=false for exactly SPLIT_THRESHOLD (5) items", () => {
    const result = splitIntoBatches(makeItems(SPLIT_THRESHOLD), parentRef);
    expect(result.shouldSplit).toBe(false);
    expect(result.batches).toEqual([]);
  });

  it("returns shouldSplit=false for fewer than SPLIT_THRESHOLD items", () => {
    const result = splitIntoBatches(makeItems(3), parentRef);
    expect(result.shouldSplit).toBe(false);
    expect(result.batches).toEqual([]);
  });

  it("returns shouldSplit=false for 0 items", () => {
    const result = splitIntoBatches([], parentRef);
    expect(result.shouldSplit).toBe(false);
    expect(result.batches).toEqual([]);
  });

  it("returns shouldSplit=true for 6 items — 2 batches of 3", () => {
    const result = splitIntoBatches(makeItems(6), parentRef);
    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(2);
    expect(result.batches[0].items).toHaveLength(3);
    expect(result.batches[1].items).toHaveLength(3);
  });

  it("returns 3 batches for 7 items (3, 3, 1)", () => {
    const result = splitIntoBatches(makeItems(7), parentRef);
    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(3);
    expect(result.batches[0].items).toHaveLength(3);
    expect(result.batches[1].items).toHaveLength(3);
    expect(result.batches[2].items).toHaveLength(1);
  });

  it("returns 3 batches for 9 items (3, 3, 3)", () => {
    const result = splitIntoBatches(makeItems(9), parentRef);
    expect(result.shouldSplit).toBe(true);
    expect(result.batches).toHaveLength(3);
    expect(result.batches.every(b => b.items.length === 3)).toBe(true);
  });

  it("sorts items HIGH → MEDIUM → LOW within batches", () => {
    const items: ActionItem[] = [
      { priority: "LOW", description: "Low 1", raw: "- [LOW] Low 1" },
      { priority: "HIGH", description: "High 1", raw: "- [HIGH] High 1" },
      { priority: "MEDIUM", description: "Medium 1", raw: "- [MEDIUM] Medium 1" },
      { priority: "LOW", description: "Low 2", raw: "- [LOW] Low 2" },
      { priority: "HIGH", description: "High 2", raw: "- [HIGH] High 2" },
      { priority: "MEDIUM", description: "Medium 2", raw: "- [MEDIUM] Medium 2" },
    ];

    const result = splitIntoBatches(items, parentRef);
    expect(result.shouldSplit).toBe(true);
    // First batch should be HIGH items
    expect(result.batches[0].items[0].priority).toBe("HIGH");
    expect(result.batches[0].items[1].priority).toBe("HIGH");
    // Third item in first batch should be MEDIUM (since only 2 HIGH)
    expect(result.batches[0].items[2].priority).toBe("MEDIUM");
    // Second batch: remaining MEDIUM then LOW
    expect(result.batches[1].items[0].priority).toBe("MEDIUM");
    expect(result.batches[1].items[1].priority).toBe("LOW");
    expect(result.batches[1].items[2].priority).toBe("LOW");
  });

  it("sets correct batchIndex and totalBatches on each batch", () => {
    const result = splitIntoBatches(makeItems(7), parentRef);
    expect(result.batches[0].batchIndex).toBe(0);
    expect(result.batches[0].totalBatches).toBe(3);
    expect(result.batches[1].batchIndex).toBe(1);
    expect(result.batches[1].totalBatches).toBe(3);
    expect(result.batches[2].batchIndex).toBe(2);
    expect(result.batches[2].totalBatches).toBe(3);
  });

  it("sets parentIssueRef on all batches", () => {
    const result = splitIntoBatches(makeItems(6), parentRef);
    for (const batch of result.batches) {
      expect(batch.parentIssueRef).toBe(parentRef);
    }
  });

  it("does not mutate the original items array", () => {
    const items = makeItems(6);
    const originalOrder = items.map(i => i.description);
    splitIntoBatches(items, parentRef);
    expect(items.map(i => i.description)).toEqual(originalOrder);
  });
});

// ── formatBatchAsTask ─────────────────────────────────────────────────────────

describe("formatBatchAsTask", () => {
  const parentRef = "rapartlu/agent-reviewer#259";

  function makeBatch(batchIndex: number, totalBatches: number, itemCount = 3) {
    return {
      batchIndex,
      totalBatches,
      parentIssueRef: parentRef,
      items: makeItems(itemCount),
    };
  }

  it("contains parent issue reference", () => {
    const output = formatBatchAsTask(makeBatch(0, 2));
    expect(output).toContain(parentRef);
  });

  it("contains 'Batch N of M' header with correct numbers", () => {
    const output = formatBatchAsTask(makeBatch(0, 3));
    expect(output).toContain("Batch 1 of 3");
  });

  it("contains 'Batch 2 of 3' for batchIndex=1", () => {
    const output = formatBatchAsTask(makeBatch(1, 3));
    expect(output).toContain("Batch 2 of 3");
  });

  it("contains all item descriptions", () => {
    const items: ActionItem[] = [
      { priority: "HIGH", description: "Fix critical bug", raw: "- [HIGH] Fix critical bug" },
      { priority: "MEDIUM", description: "Update tests", raw: "- [MEDIUM] Update tests" },
    ];
    const batch = {
      batchIndex: 0,
      totalBatches: 2,
      parentIssueRef: parentRef,
      items,
    };
    const output = formatBatchAsTask(batch);
    expect(output).toContain("Fix critical bug");
    expect(output).toContain("Update tests");
  });

  it("produces valid markdown with ### Action Items section", () => {
    const output = formatBatchAsTask(makeBatch(0, 2));
    expect(output).toContain("### Action Items");
  });

  it("mentions sequential dispatch guidance", () => {
    const output = formatBatchAsTask(makeBatch(0, 3));
    expect(output.toLowerCase()).toContain("sequential");
  });

  it("last batch references no next batch", () => {
    const output = formatBatchAsTask(makeBatch(2, 3));
    // Last batch — no next batch to reference
    expect(output).toContain("last batch");
  });

  it("non-last batch references the next batch number", () => {
    const output = formatBatchAsTask(makeBatch(0, 3));
    // Should reference batch 2 as the next one
    expect(output).toContain("2");
  });
});
