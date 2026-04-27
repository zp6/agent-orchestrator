/**
 * Scope-contract preflight checks for hard dispatch constraints.
 *
 * The orchestrator prompt can contain explicit hard limits such as:
 *   - exactly 1 file
 *   - max 200 lines
 *   - do not touch triggers/verifier/agents.yaml
 *
 * This helper parses those constraints from the prompt text and checks a PR
 * diff against them before the reviewer spends another LLM cycle on a scope
 * violation.
 */

import { extractChangedFilesFromDiff } from "./schema-impact.js";

export type ScopeContractViolationType = "file-count" | "line-count" | "forbidden-paths" | "clean";

export interface ExactFileCountConstraint {
  kind: "exact-file-count";
  value: number;
  raw: string;
}

export interface MaxLineCountConstraint {
  kind: "max-lines";
  value: number;
  raw: string;
}

export interface ForbiddenPathsConstraint {
  kind: "forbidden-paths";
  paths: string[];
  raw: string;
}

export type ScopeContractConstraint =
  | ExactFileCountConstraint
  | MaxLineCountConstraint
  | ForbiddenPathsConstraint;

export interface ScopeContractViolation {
  type: ScopeContractViolationType;
  reason: string;
  constraint: ScopeContractConstraint | null;
}

export interface ScopeContractCheckResult {
  violation: boolean;
  violation_type: ScopeContractViolationType;
  constraints: ScopeContractConstraint[];
  changed_files: string[];
  changed_lines: number;
  reason: string;
  violation_detail: ScopeContractViolation | null;
  comment: string;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const EXACT_FILE_RE = /\b(?:exactly|strictly)\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+file(?:s)?\b/gi;
const MAX_LINE_RE = /\bmax(?:imum)?\s+(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+lines?\b/gi;
const FORBIDDEN_RE =
  /\b(?:do not touch|do not change|do not modify|don't touch|don't change|don't modify|zero changes to)\s+([^\n;]+)/gi;
const PATH_TOKEN_RE = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*/g;

function parseCount(value: string): number | null {
  const numeric = Number.parseInt(value, 10);
  if (Number.isFinite(numeric)) return numeric;
  return NUMBER_WORDS[value.toLowerCase()] ?? null;
}

function normalizePath(value: string): string {
  return value.trim().replace(/^[`"']+|[`"']+$/g, "").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

function pathMatches(filePath: string, forbiddenPath: string): boolean {
  const file = normalizePath(filePath);
  const forbidden = normalizePath(forbiddenPath);
  return (
    file === forbidden ||
    file.startsWith(`${forbidden}/`) ||
    forbidden.startsWith(`${file}/`) ||
    file.includes(`/${forbidden}`) ||
    forbidden.includes(`/${file}`)
  );
}

function extractForbiddenPaths(text: string): ForbiddenPathsConstraint[] {
  const constraints: ForbiddenPathsConstraint[] = [];

  for (const match of text.matchAll(FORBIDDEN_RE)) {
    const segment = match[1] ?? "";
    const paths = new Set<string>();

    for (const token of segment.matchAll(PATH_TOKEN_RE)) {
      const path = normalizePath(token[0]);
      if (path) paths.add(path);
    }

    if (paths.size === 0) {
      for (const part of segment.split(/(?:,| and | or |\/)/i)) {
        const path = normalizePath(part);
        if (path && /[A-Za-z0-9]/.test(path)) {
          paths.add(path);
        }
      }
    }

    if (paths.size > 0) {
      constraints.push({
        kind: "forbidden-paths",
        paths: [...paths],
        raw: match[0].trim(),
      });
    }
  }

  return constraints;
}

export function extractScopeContractConstraints(text: string): ScopeContractConstraint[] {
  const constraints: ScopeContractConstraint[] = [];

  for (const match of text.matchAll(EXACT_FILE_RE)) {
    const value = parseCount(match[1] ?? "");
    if (value !== null) {
      constraints.push({
        kind: "exact-file-count",
        value,
        raw: match[0].trim(),
      });
    }
  }

  for (const match of text.matchAll(MAX_LINE_RE)) {
    const value = parseCount(match[1] ?? "");
    if (value !== null) {
      constraints.push({
        kind: "max-lines",
        value,
        raw: match[0].trim(),
      });
    }
  }

  constraints.push(...extractForbiddenPaths(text));
  return constraints;
}

function countChangedLines(diff: string): number {
  return diff
    .split(/\r?\n/)
    .filter((line) => {
      if (!line) return false;
      if (line.startsWith("diff --git")) return false;
      if (line.startsWith("@@")) return false;
      if (line.startsWith("---") || line.startsWith("+++")) return false;
      return line.startsWith("+") || line.startsWith("-");
    }).length;
}

function summarizeConstraints(constraints: ScopeContractConstraint[]): string {
  if (constraints.length === 0) return "No hard scope constraints were detected.";
  return constraints
    .map((constraint) => {
      if (constraint.kind === "exact-file-count") return `- ${constraint.raw}`;
      if (constraint.kind === "max-lines") return `- ${constraint.raw}`;
      return `- ${constraint.raw}`;
    })
    .join("\n");
}

function formatViolation(
  type: ScopeContractViolationType,
  reason: string,
  constraint: ScopeContractConstraint | null,
  changedFiles: string[],
  changedLines: number,
  constraints: ScopeContractConstraint[],
): ScopeContractCheckResult {
  const summary = summarizeConstraints(constraints);
  const comment = [
    "**[orchestrator] Scope contract violated**",
    "",
    reason,
    "",
    `Observed: ${changedFiles.length} file(s), ${changedLines} changed line(s).`,
    "",
    "Parsed constraints:",
    summary,
  ].join("\n");

  return {
    violation: true,
    violation_type: type,
    constraints,
    changed_files: changedFiles,
    changed_lines: changedLines,
    reason,
    violation_detail: { type, reason, constraint },
    comment,
  };
}

export function checkScopeContract(
  promptText: string,
  diff: string,
): ScopeContractCheckResult {
  const constraints = extractScopeContractConstraints(promptText);
  const changedFiles = extractChangedFilesFromDiff(diff);
  const changedLines = countChangedLines(diff);

  for (const constraint of constraints) {
    if (constraint.kind === "exact-file-count" && changedFiles.length !== constraint.value) {
      return formatViolation(
        "file-count",
        `Expected exactly ${constraint.value} file(s), but the diff changes ${changedFiles.length}.`,
        constraint,
        changedFiles,
        changedLines,
        constraints,
      );
    }

    if (constraint.kind === "max-lines" && changedLines > constraint.value) {
      return formatViolation(
        "line-count",
        `Expected no more than ${constraint.value} changed lines, but the diff changes ${changedLines}.`,
        constraint,
        changedFiles,
        changedLines,
        constraints,
      );
    }

    if (constraint.kind === "forbidden-paths") {
      const touched = changedFiles.filter((file) =>
        constraint.paths.some((forbidden) => pathMatches(file, forbidden)),
      );

      if (touched.length > 0) {
        return formatViolation(
          "forbidden-paths",
          `The diff touches forbidden path(s): ${touched.join(", ")}.`,
          constraint,
          changedFiles,
          changedLines,
          constraints,
        );
      }
    }
  }

  return {
    violation: false,
    violation_type: "clean",
    constraints,
    changed_files: changedFiles,
    changed_lines: changedLines,
    reason: "No hard scope contract violation detected.",
    violation_detail: null,
    comment: summarizeConstraints(constraints),
  };
}

export function formatScopeContractViolationComment(
  result: ScopeContractCheckResult,
  context: { prNumber?: number; title?: string } = {},
): string {
  const header = context.prNumber ? `PR #${context.prNumber}` : "This PR";
  const titleLine = context.title ? `Title: ${context.title}` : null;
  const detailLine = result.violation_detail
    ? `Violation: ${result.violation_detail.reason}`
    : `Violation: ${result.reason}`;

  return [
    `**[orchestrator] Scope contract violated**`,
    "",
    `${header} was rejected before review could continue.`,
    titleLine,
    detailLine,
    "",
    `Observed: ${result.changed_files.length} file(s), ${result.changed_lines} changed line(s).`,
    "",
    "Parsed constraints:",
    summarizeConstraints(result.constraints),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}
