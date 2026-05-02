import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { StateStore, Task, TaskLog } from "../state/store.js";

export const DISCIPLINE_DOCS = ["CLAUDE.md", "CHARTER.md"] as const;

const DISCOURAGED_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "Substack", pattern: /\bSubstack\b/i },
  { label: "Stripe Connect", pattern: /\bStripe Connect\b/i },
  { label: "Polar paid tier", pattern: /\bPolar\b.*\bpaid tier\b/i },
  { label: "Sponsors signup", pattern: /\bSponsors?\b|\bsign up for\b/i },
  { label: "Algora signup", pattern: /\bAlgora\b/i },
  { label: "operator action required", pattern: /\boperator action required\b/i },
  { label: "KYC chain", pattern: /\bKYC\b|\bfiat\b|\bStripe\b/i },
];

export interface DisciplineDocSnapshot {
  path: string;
  exists: boolean;
  sha256: string | null;
  size_bytes: number | null;
}

export interface DisciplineContextSnapshot {
  captured_at: string;
  root_dir: string;
  docs: DisciplineDocSnapshot[];
}

export interface DisciplineConflictAssessment {
  aligned: boolean;
  matched_patterns: string[];
  requires_rescope: boolean;
  reason: string | null;
}

export function captureDisciplineContext(rootDir: string): DisciplineContextSnapshot {
  const capturedAt = new Date().toISOString();
  const docs = DISCIPLINE_DOCS.map((name) => {
    const path = resolve(rootDir, name);
    try {
      const content = readFileSync(path);
      return {
        path: name,
        exists: true,
        sha256: createHash("sha256").update(content).digest("hex"),
        size_bytes: content.length,
      };
    } catch {
      return {
        path: name,
        exists: false,
        sha256: null,
        size_bytes: null,
      };
    }
  });

  return { captured_at: capturedAt, root_dir: rootDir, docs };
}

export function detectDisciplineConflict(text: string): DisciplineConflictAssessment {
  const matchedPatterns = DISCOURAGED_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ label }) => label);

  if (matchedPatterns.length === 0) {
    return {
      aligned: true,
      matched_patterns: [],
      requires_rescope: false,
      reason: null,
    };
  }

  return {
    aligned: false,
    matched_patterns: matchedPatterns,
    requires_rescope: true,
    reason: `Task mentions current discipline anti-pattern(s): ${matchedPatterns.join(", ")}`,
  };
}

export function formatDisciplineRefreshBlock(snapshot: DisciplineContextSnapshot, taskText: string): string {
  const assessment = detectDisciplineConflict(taskText);
  const docLines = snapshot.docs
    .map((doc) => `- ${doc.path}: ${doc.exists ? `${doc.sha256?.slice(0, 12) ?? "missing"} (${doc.size_bytes} bytes)` : "missing"}`)
    .join("\n");

  const conflictLine = assessment.requires_rescope
    ? `\n\n⚠️ The task text already matches discipline anti-pattern(s): ${assessment.matched_patterns.join(", ")}. Re-scope before continuing.`
    : "";

  return (
    `\n\n## Discipline refresh\n` +
    `Before doing any substantive work, re-read the current \`CLAUDE.md\` and \`CHARTER.md\` in this repository, then compare the task against the live discipline.\n` +
    `If the task conflicts with current doctrine, re-scope or escalate immediately instead of continuing on the original plan.\n` +
    `Current snapshot (${snapshot.captured_at}):\n${docLines}${conflictLine}\n`
  );
}

function parseDisciplineSnapshotLog(log: TaskLog | undefined): DisciplineContextSnapshot | null {
  if (!log) return null;
  const marker = "[discipline-context]";
  if (!log.content.startsWith(marker)) return null;
  try {
    const raw = log.content.slice(marker.length).trim();
    return JSON.parse(raw) as DisciplineContextSnapshot;
  } catch {
    return null;
  }
}

export function readTaskDisciplineSnapshot(store: StateStore, taskId: string): DisciplineContextSnapshot | null {
  const log = store.getLatestTaskLogByPrefix(taskId, "[discipline-context]");
  return parseDisciplineSnapshotLog(log);
}

export function storeDisciplineContextSnapshot(store: StateStore, taskId: string, snapshot: DisciplineContextSnapshot): void {
  store.addLog({
    task_id: taskId,
    direction: "system",
    content: `[discipline-context] ${JSON.stringify(snapshot)}`,
  });
}

export function assessTaskDisciplineAlignment(
  task: Pick<Task, "title" | "description" | "result" | "source_ref">,
  currentSnapshot: DisciplineContextSnapshot,
  priorSnapshot: DisciplineContextSnapshot | null,
): DisciplineConflictAssessment & { stale_snapshot: boolean } {
  const text = [task.title, task.description, task.result, task.source_ref].filter(Boolean).join("\n");
  const conflict = detectDisciplineConflict(text);
  const staleSnapshot =
    !!priorSnapshot &&
    JSON.stringify(priorSnapshot.docs.map((doc) => [doc.path, doc.sha256]).sort()) !==
      JSON.stringify(currentSnapshot.docs.map((doc) => [doc.path, doc.sha256]).sort());

  if (!staleSnapshot && conflict.aligned) {
    return { ...conflict, stale_snapshot: false };
  }

  if (staleSnapshot) {
    return {
      aligned: false,
      matched_patterns: conflict.matched_patterns,
      requires_rescope: true,
      reason: conflict.requires_rescope
        ? `Discipline docs changed since dispatch and the task still matches discipline anti-pattern(s): ${conflict.matched_patterns.join(", ")}`
        : "Discipline docs changed since dispatch; task must be re-read and re-evaluated before approval.",
      stale_snapshot: true,
    };
  }

  return { ...conflict, stale_snapshot: false };
}
