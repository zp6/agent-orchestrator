/**
 * Failure antibody auto-harvest and fitness tracking.
 *
 * This module turns verifier success/failure sequences into structured
 * `failure_antibody` signals and updates their confidence as they are
 * injected into later dispatches.
 */

import type { Signal, StateStore, Task } from "../state/store.js";
import { findExistingPRsForIssue } from "../triggers/github.js";

export const FAILURE_ANTIBODY_SIGNAL_TYPE = "failure_antibody";
const INITIAL_CONFIDENCE = 0.5;
const SUCCESS_BONUS = 0.05;
const FAILURE_PENALTY = 0.1;
const MIN_CONFIDENCE = 0.2;
const MIN_INJECTIONS_BEFORE_CULL = 10;
const MAX_MATCHES = 3;
const SIMILARITY_THRESHOLD = 0.15;

export interface FailureAntibodyValue {
  fix_hint: string;
  error_class: string;
  source_pr: string;
  source_failure_task_id?: string;
  source_success_task_id?: string;
}

export interface FailureAntibodyMatch {
  signal: Signal;
  score: number;
  value: FailureAntibodyValue | null;
}

export interface FailureAntibodyDispatchResult {
  flagged: boolean;
  matches: FailureAntibodyMatch[];
  warningBlock: string;
}

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "was", "are", "were", "be", "been",
  "this", "that", "it", "its", "as", "if", "not", "no", "so", "do",
  "does", "did", "will", "would", "can", "could", "should", "may", "might",
  "has", "have", "had", "we", "i", "you", "they", "he", "she",
]);

const ERROR_CLASS_PATTERNS: Array<[string, RegExp]> = [
  ["authentication", /\b(auth|unauthori[sz]ed|forbidden|permission denied|gh token|token)\b/i],
  ["dependency", /\b(econnrefused|enotfound|eai_again|timed out|timeout|network|connection refused|dependency)\b/i],
  ["filesystem", /\b(enoent|eacces|no such file|file not found|permission denied)\b/i],
  ["validation", /\b(validation|invalid|schema|missing required|malformed)\b/i],
  ["build", /\b(tsc|typescript|compile|compilation|syntax error|parse error|build failed|eslint|lint)\b/i],
  ["test", /\b(test failed|assert|expect\(|vitest|jest|pytest|snapshot)\b/i],
  ["git", /\b(merge conflict|rebase|non-fast-forward|push rejected|branch)\b/i],
  ["runtime", /\b(typeerror|referenceerror|rangeerror|cannot read|undefined is not|exception|panic)\b/i],
  ["api", /\b(404|403|429|bad request|unprocessable|unexpected response|rate limit|api)\b/i],
];

function tokenise(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s/-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !STOP_WORDS.has(t)),
  );
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function normaliseText(text: string): string {
  return text
    .toLowerCase()
    .replace(/`[^`]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " <url> ")
    .replace(/[A-Fa-f0-9]{7,40}/g, " <id> ")
    .replace(/\b\d+\b/g, " <n> ")
    .replace(/[^\w\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function summariseFixHint(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 160) return cleaned;
  return `${cleaned.slice(0, 157).trimEnd()}...`;
}

function parseSourceRef(sourceRef: string | null | undefined): { repo: string; number: number } | null {
  if (!sourceRef) return null;
  const match = sourceRef.match(/^([^#]+)#(\d+)$/);
  if (!match) return null;
  return { repo: match[1], number: Number(match[2]) };
}

function resolveSourcePrRef(task: Task): string | null {
  const parsed = parseSourceRef(task.source_ref);
  if (!parsed) return null;

  // PR feedback tasks already point directly at the PR being fixed.
  if (task.source === "pr-feedback") {
    return task.source_ref;
  }

  const linkedPRs = findExistingPRsForIssue(parsed.repo, parsed.number);
  const mergedPR = linkedPRs.find((pr) => pr.state === "merged");
  const selectedPR = mergedPR ?? linkedPRs[0];
  if (!selectedPR) return null;

  return `${parsed.repo}#${selectedPR.number}`;
}

function readFailureAntibodyValue(signal: Signal): FailureAntibodyValue | null {
  if (!signal.value) return null;
  try {
    const parsed = JSON.parse(signal.value) as Partial<FailureAntibodyValue>;
    if (!parsed.fix_hint || !parsed.error_class || !parsed.source_pr) return null;
    return {
      fix_hint: String(parsed.fix_hint),
      error_class: String(parsed.error_class),
      source_pr: String(parsed.source_pr),
      source_failure_task_id: parsed.source_failure_task_id ? String(parsed.source_failure_task_id) : undefined,
      source_success_task_id: parsed.source_success_task_id ? String(parsed.source_success_task_id) : undefined,
    };
  } catch {
    return null;
  }
}

export function classifyFailureErrorClass(text: string | null | undefined): string {
  if (!text) return "unknown";
  for (const [label, pattern] of ERROR_CLASS_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return "unknown";
}

export function normaliseFailureSignature(text: string | null | undefined): string {
  if (!text) return "unknown";
  return normaliseText(text)
    .replace(/\bline \d+\b/g, "line <n>")
    .replace(/\bcolumn \d+\b/g, "column <n>")
    .slice(0, 180) || "unknown";
}

function buildFailureAntibodyBlock(matches: FailureAntibodyMatch[]): string {
  if (matches.length === 0) return "";

  const items = matches.map((match) => {
    const value = match.value;
    const score = Math.round(match.score * 100);
    const source = value?.source_pr ?? `#${match.signal.id}`;
    const errorClass = value?.error_class ?? "unknown";
    const hint = value?.fix_hint ?? "";
    return `- [${score}%] ${match.signal.key} (${errorClass}) from ${source}${hint ? `\n  Fix hint: ${hint}` : ""}`;
  });

  return (
    `\n\n## 🧬 Failure Antibody — Known Fix Patterns\n` +
    `The following auto-harvested signals match this task.\n` +
    `Use the fix hint as a remediation template, but verify it against the current codebase:\n\n` +
    items.join("\n\n") +
    `\n`
  );
}

function scoreSignalAgainstMessage(message: string, signal: Signal, value: FailureAntibodyValue | null): number {
  const messageTokens = tokenise(message);
  const signalTokens = new Set<string>([
    ...tokenise(signal.key),
    ...(value ? tokenise(`${value.fix_hint} ${value.error_class}`) : []),
  ]);

  let score = jaccardSimilarity(messageTokens, signalTokens);
  if (value?.error_class && message.toLowerCase().includes(value.error_class.toLowerCase())) {
    score = Math.max(score, 0.25);
  }
  if (signal.key && message.toLowerCase().includes(signal.key.toLowerCase())) {
    score = Math.max(score, 0.4);
  }
  return score;
}

function findLatestClassifiableFailure(task: Task, store: StateStore): Task | null {
  if (!task.source_ref) return null;

  const attempts = store.getPriorAttempts(task.source_ref);
  for (const attempt of attempts) {
    if (attempt.id === task.id) continue;
    if (attempt.verification_status !== "rejected") continue;
    const sourceText = attempt.verification_notes ?? attempt.result ?? null;
    if (!sourceText) continue;
    if (classifyFailureErrorClass(sourceText) === "unknown") continue;
    return {
      ...task,
      id: attempt.id,
      result: attempt.result,
      verification_status: attempt.verification_status as Task["verification_status"],
      quality_score: attempt.quality_score,
      verification_notes: attempt.verification_notes,
      created_at: attempt.created_at,
    } as Task;
  }

  return null;
}

export function harvestFailureAntibodyForTask(
  store: StateStore,
  task: Task,
  fixContext?: string | null,
): Signal | null {
  if (task.verification_status !== "approved" || !task.source_ref) return null;

  const failedAttempt = findLatestClassifiableFailure(task, store);
  if (!failedAttempt) return null;

  // Re-read the latest persisted task so the fix hint can use the final
  // implementation result instead of a stale in-memory snapshot.
  const currentTask = store.getTask(task.id) ?? task;
  const parsed = parseSourceRef(task.source_ref);
  if (!parsed) return null;

  const failureText = failedAttempt.verification_notes ?? failedAttempt.result ?? "";
  const errorClass = classifyFailureErrorClass(failureText);
  if (errorClass === "unknown") return null;

  const key = normaliseFailureSignature(failureText);
  const sourcePr = resolveSourcePrRef(task);
  if (!sourcePr) return null;
  const fixHintSource =
    fixContext ??
    currentTask.result ??
    task.result ??
    currentTask.verification_notes ??
    task.verification_notes ??
    task.description ??
    task.title;
  const fixHint = summariseFixHint(fixHintSource ?? "");
  const value: FailureAntibodyValue = {
    fix_hint: fixHint,
    error_class: errorClass,
    source_pr: sourcePr,
    source_failure_task_id: failedAttempt.id,
    source_success_task_id: task.id,
  };

  const existing = store
    .readSignals({ signal_type: FAILURE_ANTIBODY_SIGNAL_TYPE, repo: parsed.repo, limit: 500 })
    .find((sig) => sig.key === key);

  if (existing) {
    const nextConfidence = Math.min(0.95, Math.max(existing.confidence, INITIAL_CONFIDENCE) + 0.05);
    return store.updateSignal(existing.id, {
      confidence: nextConfidence,
      value,
    }) ?? existing;
  }

  return store.writeSignal({
    agent: task.agent_name ?? "verifier",
    signal_type: FAILURE_ANTIBODY_SIGNAL_TYPE,
    key,
    value,
    repo: parsed.repo,
    confidence: INITIAL_CONFIDENCE,
    ttl_hours: 24 * 90,
  });
}

export function applyFailureAntibodyFitness(
  store: StateStore,
  taskId: string,
  outcome: "approved" | "rejected",
  errorText?: string | null,
): number {
  const injected = store.getSignalsReadByContext(taskId, FAILURE_ANTIBODY_SIGNAL_TYPE);
  if (injected.length === 0) return 0;

  const failedClass = outcome === "rejected" ? classifyFailureErrorClass(errorText ?? null) : null;
  let updated = 0;

  for (const signal of injected) {
    const value = readFailureAntibodyValue(signal);
    if (!value) continue;

    if (outcome === "approved") {
      const nextConfidence = Math.min(0.95, signal.confidence + SUCCESS_BONUS);
      store.updateSignal(signal.id, { confidence: nextConfidence });
      updated++;
    } else if (failedClass && failedClass !== "unknown" && failedClass === value.error_class) {
      const nextConfidence = Math.max(0, signal.confidence - FAILURE_PENALTY);
      store.updateSignal(signal.id, { confidence: nextConfidence });
      updated++;
    }

    const reads = store.countSignalReads(signal.id);
    const refreshed = store.getSignalById(signal.id);
    if (refreshed && reads >= MIN_INJECTIONS_BEFORE_CULL && refreshed.confidence < MIN_CONFIDENCE) {
      store.deleteSignal(signal.id);
    }
  }

  return updated;
}

export function runFailureAntibodyPreDispatchCheck(
  store: StateStore,
  message: string,
  taskId: string,
  agentName: string,
  repo?: string,
  limit = 100,
): FailureAntibodyDispatchResult {
  const signals = store.readSignals({ signal_type: FAILURE_ANTIBODY_SIGNAL_TYPE, repo, limit });
  const matches: FailureAntibodyMatch[] = [];

  for (const signal of signals) {
    const value = readFailureAntibodyValue(signal);
    const score = scoreSignalAgainstMessage(message, signal, value);
    if (score >= SIMILARITY_THRESHOLD) {
      matches.push({ signal, score, value });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  const topMatches = matches.slice(0, MAX_MATCHES);

  for (const match of topMatches) {
    store.recordSignalRead(match.signal.id, agentName, taskId);
  }

  return {
    flagged: topMatches.length > 0,
    matches: topMatches,
    warningBlock: buildFailureAntibodyBlock(topMatches),
  };
}
