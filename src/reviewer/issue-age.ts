import type { SupervisorDecisionRecord, Task } from "../state/types.js";

export type IssueAgeBucket = "0-7d" | "7-14d" | "14-30d" | "30d+";
export type IssueAgeSeverity = "green" | "yellow" | "orange" | "red";

export interface IssueAgeEntry {
  taskId: string;
  issueRef: string | null;
  title: string;
  agentName: string | null;
  status: Task["status"];
  ageDays: number;
  bucket: IssueAgeBucket;
  severity: IssueAgeSeverity;
  dispatchAttempts: number;
  lastDispatchAttemptAt: string | null;
}

export interface IssueAgeBucketSummary {
  bucket: IssueAgeBucket;
  label: string;
  severity: IssueAgeSeverity;
  count: number;
  tasks: IssueAgeEntry[];
}

export interface IssueAgeHeatmap {
  generatedAt: string;
  total: number;
  buckets: IssueAgeBucketSummary[];
}

export interface IssueAgeEscalationCandidate extends IssueAgeEntry {
  shouldNudge: boolean;
  shouldForceDispatch: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const BUCKET_META: Record<IssueAgeBucket, { label: string; severity: IssueAgeSeverity; minDays: number }> = {
  "0-7d": { label: "<7d", severity: "green", minDays: 0 },
  "7-14d": { label: "7-14d", severity: "yellow", minDays: 7 },
  "14-30d": { label: "14-30d", severity: "orange", minDays: 14 },
  "30d+": { label: "30d+", severity: "red", minDays: 30 },
};

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalize(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function extractIssueNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(/#?(\d{1,10})/);
  return match?.[1] ?? null;
}

function issueRefMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = normalize(a);
  const right = normalize(b);
  if (!left || !right) return false;
  if (left === right || left.includes(right) || right.includes(left)) return true;

  const leftIssue = extractIssueNumber(left);
  const rightIssue = extractIssueNumber(right);
  if (leftIssue && rightIssue && leftIssue === rightIssue) return true;

  return false;
}

function isOpenIssueTask(task: Task): boolean {
  return task.status !== "done" && task.status !== "failed";
}

function ageDays(createdAt: string, nowMs: number): number {
  const createdMs = parseTimestamp(createdAt);
  if (createdMs === null) return 0;
  return Math.max(0, Math.floor((nowMs - createdMs) / DAY_MS));
}

export function classifyIssueAge(daysOld: number): IssueAgeBucket {
  if (daysOld >= 30) return "30d+";
  if (daysOld >= 14) return "14-30d";
  if (daysOld >= 7) return "7-14d";
  return "0-7d";
}

export function buildIssueAgeEntry(
  task: Task,
  nowMs: number = Date.now(),
  decisions: SupervisorDecisionRecord[] = [],
): IssueAgeEntry {
  const daysOld = ageDays(task.created_at, nowMs);
  const bucket = classifyIssueAge(daysOld);
  const relevantDecisions = decisions.filter((decision) => isDispatchAttemptForTask(task, decision));
  const lastDispatchAttemptAt =
    relevantDecisions.length > 0
      ? relevantDecisions.reduce((latest, decision) => {
          if (!latest) return decision.created_at;
          const currentMs = parseTimestamp(decision.created_at) ?? 0;
          const latestMs = parseTimestamp(latest) ?? 0;
          return currentMs > latestMs ? decision.created_at : latest;
        }, relevantDecisions[0].created_at)
      : null;

  return {
    taskId: task.id,
    issueRef: task.source_ref ?? null,
    title: task.title,
    agentName: task.agent_name ?? null,
    status: task.status,
    ageDays: daysOld,
    bucket,
    severity: BUCKET_META[bucket].severity,
    dispatchAttempts: relevantDecisions.length,
    lastDispatchAttemptAt,
  };
}

export function buildIssueAgeHeatmap(
  tasks: Task[],
  decisions: SupervisorDecisionRecord[] = [],
  nowMs: number = Date.now(),
): IssueAgeHeatmap {
  const entries = tasks
    .filter((task) => task.source_ref && isOpenIssueTask(task))
    .map((task) => buildIssueAgeEntry(task, nowMs, decisions))
    .sort((a, b) => b.ageDays - a.ageDays || a.title.localeCompare(b.title));

  const grouped = new Map<IssueAgeBucket, IssueAgeEntry[]>();
  for (const bucket of Object.keys(BUCKET_META) as IssueAgeBucket[]) {
    grouped.set(bucket, []);
  }

  for (const entry of entries) {
    grouped.get(entry.bucket)?.push(entry);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    total: entries.length,
    buckets: (Object.keys(BUCKET_META) as IssueAgeBucket[]).map((bucket) => ({
      bucket,
      label: BUCKET_META[bucket].label,
      severity: BUCKET_META[bucket].severity,
      count: grouped.get(bucket)?.length ?? 0,
      tasks: grouped.get(bucket) ?? [],
    })),
  };
}

export function formatIssueAgeHeatmap(heatmap: IssueAgeHeatmap): string[] {
  const iconBySeverity: Record<IssueAgeSeverity, string> = {
    green: "🟩",
    yellow: "🟨",
    orange: "🟧",
    red: "🟥",
  };

  const lines = [`🔥 *Issue age heatmap* (${heatmap.total} open issue${heatmap.total === 1 ? "" : "s"})`];
  for (const bucket of heatmap.buckets) {
    lines.push(`  ${iconBySeverity[bucket.severity]} ${bucket.label}: ${bucket.count}`);
  }
  return lines;
}

export function collectIssueAgeEscalations(
  tasks: Task[],
  decisions: SupervisorDecisionRecord[] = [],
  nowMs: number = Date.now(),
): IssueAgeEscalationCandidate[] {
  const entries = tasks
    .filter((task) => task.source_ref && isOpenIssueTask(task))
    .map((task) => buildIssueAgeEntry(task, nowMs, decisions));

  return entries
    .map((entry) => ({
      ...entry,
      shouldNudge: entry.ageDays >= 14 && entry.dispatchAttempts === 0,
      shouldForceDispatch: entry.ageDays >= 30,
    }))
    .filter((entry) => entry.shouldNudge || entry.shouldForceDispatch)
    .sort((a, b) => b.ageDays - a.ageDays || a.title.localeCompare(b.title));
}

export function hasRecentAgeNudge(
  task: Task,
  decisions: SupervisorDecisionRecord[],
  nowMs: number = Date.now(),
  windowMs: number = 7 * DAY_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  return decisions.some((decision) => {
    if (decision.action !== "age-nudge") return false;
    const createdMs = parseTimestamp(decision.created_at);
    if (createdMs === null || createdMs < cutoff) return false;
    if (task.id && decision.task_id && task.id.startsWith(decision.task_id)) return true;
    return (
      issueRefMatches(task.source_ref, decision.issue_ref) ||
      issueRefMatches(task.source_ref, decision.reason) ||
      issueRefMatches(task.source_ref, decision.message)
    );
  });
}

export function hasRecentAgeDispatchDecision(
  task: Task,
  decisions: SupervisorDecisionRecord[],
  nowMs: number = Date.now(),
  windowMs: number = 24 * DAY_MS,
): boolean {
  const cutoff = nowMs - windowMs;
  return decisions.some((decision) => {
    if (decision.action !== "dispatch") return false;
    const createdMs = parseTimestamp(decision.created_at);
    if (createdMs === null || createdMs < cutoff) return false;
    if (task.id && decision.task_id && task.id.startsWith(decision.task_id)) return true;
    if (!/age escalation/i.test(decision.reason)) return false;
    return (
      issueRefMatches(task.source_ref, decision.issue_ref) ||
      issueRefMatches(task.source_ref, decision.message) ||
      issueRefMatches(task.source_ref, decision.reason)
    );
  });
}

function isDispatchAttemptForTask(task: Task, decision: SupervisorDecisionRecord): boolean {
  if (decision.action !== "dispatch") return false;
  if (task.id && decision.task_id && task.id.startsWith(decision.task_id)) return true;
  if (issueRefMatches(task.source_ref, decision.issue_ref)) return true;
  if (issueRefMatches(task.source_ref, decision.message)) return true;
  return issueRefMatches(task.source_ref, decision.reason);
}
