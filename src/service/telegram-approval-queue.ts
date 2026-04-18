/**
 * telegram-approval-queue.ts
 *
 * Enriches the Telegram operator approval notification with a rich task context
 * card so operators can approve or reject borderline tasks without ever opening
 * the dashboard or GitHub.
 *
 * Context card includes:
 *   - Task title, ID, agent, source ref
 *   - Quality score and per-dimension breakdown with traffic-light icons
 *   - PR link (fetched via `gh` CLI from the task's source_ref)
 *   - One-sentence LLM-generated risk summary
 *   - Ready-to-use /approve and /reject reply hints
 *
 * Issue #937: https://github.com/rapartlu/agent-orchestrator/issues/937
 */

import { execSync } from "node:child_process";
import type { StateStore } from "../state/store.js";
import type { ReviewerClient, VerificationResult } from "../client/reviewer-client.js";
import type { Task } from "../state/store.js";
import { notifyOperator } from "./notify.js";
import { createLogger } from "./logger.js";

const log = createLogger("approval-queue");

/**
 * Score range for the operator approval queue.
 *
 * Tasks rejected with scores in [MIN, MAX] are borderline — the automated
 * verifier said "no" but a human might reasonably say "yes". Outside this
 * range the task is clearly good (approved by verifier) or clearly bad
 * (score < MIN, no ambiguity, just dispatch a revision).
 */
export const APPROVAL_QUEUE_MIN_SCORE = 0.40;
export const APPROVAL_QUEUE_MAX_SCORE = 0.74;

// ── PR URL lookup ──────────────────────────────────────────────────────────────

/**
 * Attempt to find the open PR URL for a task via its source_ref.
 * Returns null on any error (fail-open).
 */
function findPRUrlForTask(task: Task): string | null {
  if (!task.source_ref) return null;
  const match = task.source_ref.match(/^(.+?)#(\d+)$/);
  if (!match) return null;
  const [, repo, issueNum] = match;
  try {
    // Search open PRs that close this issue number
    const raw = execSync(
      `gh pr list --repo ${repo} --state open --json url,body --jq '[.[] | select(.body | test("(?i)(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\\\\s+#${issueNum}\\\\b"))] | .[0].url'`,
      { encoding: "utf-8", timeout: 8000 },
    ).trim();
    if (raw && raw.startsWith("https://")) return raw;
  } catch { /* best effort */ }
  return null;
}

// ── Context card formatting ────────────────────────────────────────────────────

function formatDimensions(dimensions: Record<string, number>): string {
  return Object.entries(dimensions)
    .map(([key, value]) => {
      const pct = (value * 100).toFixed(0);
      const icon = value >= 0.70 ? "🟢" : value >= 0.50 ? "🟡" : "🔴";
      const label = key.replace(/_/g, " ");
      return `  ${icon} ${label}: ${pct}%`;
    })
    .join("\n");
}

/**
 * Build the Markdown context card sent to the operator.
 * Designed to be readable in a Telegram message with no additional context.
 */
export function formatApprovalCard(
  task: Task,
  result: VerificationResult,
  prUrl: string | null,
  riskSummary: string,
): string {
  const taskShort = task.id.slice(0, 8);
  const scorePct = (result.score * 100).toFixed(0);
  const agentLabel = task.agent_name ?? "unknown";
  const sourceRef = task.source_ref ?? "no ref";

  const dimSection =
    result.dimensions && Object.keys(result.dimensions).length > 0
      ? `\n*Dimensions:*\n${formatDimensions(result.dimensions)}\n`
      : "";

  const prSection = prUrl ? `\n*PR:* ${prUrl}\n` : "";

  const lines = [
    `*Task:* ${task.title.slice(0, 80)}`,
    `*ID:* \`${taskShort}\` · *Agent:* ${agentLabel} · *Ref:* \`${sourceRef}\``,
    `*Score:* ${scorePct}% _(below quality threshold)_`,
    prSection.trim(),
    dimSection.trim(),
    `*Risk:* ${riskSummary}`,
    "",
    `Reply \`/approve ${taskShort}\` to force-approve or \`/reject ${taskShort}\` to confirm rejection.`,
  ].filter((l) => l !== undefined);

  return lines.join("\n");
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Enqueue a borderline-rejected task for operator approval and send a rich
 * Telegram notification with full context.
 *
 * Only acts when the task's score falls in [APPROVAL_QUEUE_MIN_SCORE, APPROVAL_QUEUE_MAX_SCORE].
 * Silently returns for scores outside this range or for tasks already queued.
 */
export async function queueForApproval(
  store: StateStore,
  reviewerClient: ReviewerClient,
  task: Task,
  result: VerificationResult,
): Promise<void> {
  // Only queue borderline rejections
  if (result.score < APPROVAL_QUEUE_MIN_SCORE || result.score > APPROVAL_QUEUE_MAX_SCORE) {
    return;
  }

  // Skip if already in the queue
  const existing = store.getApprovalQueueEntry(task.id);
  if (existing) return;

  log.info("Queuing task for operator approval", {
    taskId: task.id,
    score: result.score,
    title: task.title,
    agent: task.agent_name,
  });

  // Gather enrichment data (PR URL is synchronous; risk summary is async LLM)
  const prUrl = findPRUrlForTask(task);
  const riskSummary = await reviewerClient
    .generateRiskSummary(task, result)
    .catch((err) => {
      log.warn("Risk summary generation failed — using notes fallback", {
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return result.notes.slice(0, 200);
    });

  // Persist to approval_queue table
  store.insertApprovalQueueEntry({
    task_id: task.id,
    title: task.title,
    agent_name: task.agent_name,
    pr_url: prUrl,
    score: result.score,
    dimensions_json:
      result.dimensions && Object.keys(result.dimensions).length > 0
        ? JSON.stringify(result.dimensions)
        : null,
    risk_summary: riskSummary,
  });

  // Send the rich context card to the operator
  const card = formatApprovalCard(task, result, prUrl, riskSummary);

  await notifyOperator(
    "Task needs operator approval",
    card,
    "warning",
    `approval-queue:${task.id}`,
  );

  log.info("Approval queue notification sent", {
    taskId: task.id,
    score: result.score,
    hasPR: !!prUrl,
    hasDimensions: !!result.dimensions,
  });
}
