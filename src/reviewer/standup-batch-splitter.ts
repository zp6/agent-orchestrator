/**
 * Standup batch splitter — issue #259
 *
 * When a standup has more than SPLIT_THRESHOLD action items, dispatching a
 * single large task leads to sprawling, low-quality PRs. This module splits
 * the action items into ordered sub-batches of BATCH_SIZE items each.
 *
 * Acceptance criteria (issue #259):
 *   ✓ Standups with >5 items emit N child tasks capped at 3 items each
 *   ✓ Each child task PR title references the parent standup issue
 *   ✓ Child tasks dispatched sequentially (prior child PR must merge before next)
 */

/** Maximum number of action items per batch. */
export const BATCH_SIZE = 3;

/** Standups with more than this many items are split into batches. */
export const SPLIT_THRESHOLD = 5;

/** Priority ordering — lower index = higher priority. */
const PRIORITY_ORDER: Record<string, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface ActionItem {
  /** Priority level: HIGH, MEDIUM, or LOW. */
  priority: string;
  /** Human-readable description of the action item. */
  description: string;
  /** Original raw line from the issue body. */
  raw: string;
}

export interface StandupBatch {
  /** 0-based index of this batch within the full set. */
  batchIndex: number;
  /** Total number of batches (ceil(items.length / BATCH_SIZE)). */
  totalBatches: number;
  /** Action items in this batch (up to BATCH_SIZE). */
  items: ActionItem[];
  /** Parent standup issue reference, e.g. "rapartlu/agent-reviewer#259". */
  parentIssueRef: string;
}

export interface BatchSplitResult {
  /** True when the standup had more than SPLIT_THRESHOLD items. */
  shouldSplit: boolean;
  /** Populated when shouldSplit is true; empty array otherwise. */
  batches: StandupBatch[];
}

// ── Parse ────────────────────────────────────────────────────────────────────

/**
 * Parse action items from a standup issue body.
 *
 * Looks for a `### Action Items` section and extracts lines in the format:
 *   `- [HIGH] description`
 *   `- [MEDIUM] description`
 *   `- [LOW] description`
 *
 * Lines outside the Action Items section are ignored.
 * "No action items." sentinel returns an empty array.
 *
 * @param body - Full GitHub issue body text.
 * @returns Parsed action items (may be empty).
 */
export function parseActionItems(body: string): ActionItem[] {
  // Find the ### Action Items section
  const sectionMatch = body.match(/###\s+Action Items\s*\n([\s\S]*?)(?:\n###|$)/);
  if (!sectionMatch) return [];

  const section = sectionMatch[1];

  // Check for explicit "no items" sentinel
  if (/No action items/i.test(section)) return [];

  const items: ActionItem[] = [];

  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    // Match "- [PRIORITY] description" format
    const match = trimmed.match(/^-\s+\[([A-Z]+)\]\s+(.+)$/);
    if (match) {
      items.push({
        priority: match[1].toUpperCase(),
        description: match[2].trim(),
        raw: trimmed,
      });
    }
  }

  return items;
}

// ── Split ────────────────────────────────────────────────────────────────────

/**
 * Split action items into ordered batches of BATCH_SIZE each.
 *
 * Items are sorted by priority (HIGH → MEDIUM → LOW) before batching so that
 * the most important work ships in the first batch.
 *
 * Only splits when `items.length > SPLIT_THRESHOLD`.
 *
 * @param items - Action items to split.
 * @param parentIssueRef - Parent standup issue reference (e.g. "owner/repo#N").
 * @returns BatchSplitResult with shouldSplit flag and populated batches.
 */
export function splitIntoBatches(
  items: ActionItem[],
  parentIssueRef: string,
): BatchSplitResult {
  if (items.length <= SPLIT_THRESHOLD) {
    return { shouldSplit: false, batches: [] };
  }

  // Sort by priority: HIGH first, then MEDIUM, then LOW; preserve order within same priority
  const sorted = [...items].sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 99;
    const pb = PRIORITY_ORDER[b.priority] ?? 99;
    return pa - pb;
  });

  // Chunk into batches of BATCH_SIZE
  const chunks: ActionItem[][] = [];
  for (let i = 0; i < sorted.length; i += BATCH_SIZE) {
    chunks.push(sorted.slice(i, i + BATCH_SIZE));
  }

  const totalBatches = chunks.length;
  const batches: StandupBatch[] = chunks.map((chunk, index) => ({
    batchIndex: index,
    totalBatches,
    items: chunk,
    parentIssueRef,
  }));

  return { shouldSplit: true, batches };
}

// ── Format ───────────────────────────────────────────────────────────────────

/**
 * Format a batch as a child task description for dispatching.
 *
 * The output markdown includes:
 * - A header referencing the parent standup issue
 * - "Batch N of M" position header
 * - The list of action items for this batch
 * - A sequential dispatch notice
 *
 * @param batch - The batch to format.
 * @returns Markdown task description suitable for dispatch.
 */
export function formatBatchAsTask(batch: StandupBatch): string {
  const { batchIndex, totalBatches, items, parentIssueRef } = batch;
  const batchNum = batchIndex + 1;

  const lines: string[] = [
    `## Standup Batch ${batchNum} of ${totalBatches}`,
    "",
    `**Parent standup:** ${parentIssueRef}`,
    "",
    `This is batch **${batchNum} of ${totalBatches}** from the standup action items. ` +
      `Please implement only the items listed below. Do not proceed to the next batch — ` +
      `it will be dispatched after this batch's PR is merged.`,
    "",
    "### Action Items",
    "",
  ];

  for (const item of items) {
    lines.push(`- [${item.priority}] ${item.description}`);
  }

  lines.push("");
  lines.push(`> **Sequential dispatch:** Batch ${batchNum + 1 <= totalBatches ? batchNum + 1 : "(none — this is the last batch)"}` +
    ` will be dispatched after this PR merges.`);
  lines.push(`> Parent: ${parentIssueRef}`);

  return lines.join("\n");
}
