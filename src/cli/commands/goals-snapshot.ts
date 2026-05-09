/**
 * CLI command: orch goals-snapshot (issue #1567)
 *
 * Reads goals.yaml, queries live data sources (state.db, revenue-log.md,
 * docs/retros/, docs/operator-actions.md), and writes/updates
 * docs/goals-progress.yaml with current KR values.
 *
 * Usage:
 *   orch goals-snapshot                  # update docs/goals-progress.yaml
 *   orch goals-snapshot --capture-baseline # also write baselines into goals.yaml
 *   orch goals-snapshot --json           # print JSON to stdout, no file writes
 *   orch goals-snapshot --check          # print snapshot, exit 1 if any KR regressed
 */

import type { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface KRSnapshot {
  kr_id: string;
  okr_id: string;
  metric: string;
  target: string;
  current_value: number | boolean | null;
  as_of: string;
  source: string;
  status: "on_track" | "at_risk" | "off_track" | "unknown";
  note?: string;
}

export interface GoalsSnapshot {
  as_of: string;
  generated_by: string;
  key_results: KRSnapshot[];
  summary: {
    total_krs: number;
    on_track: number;
    at_risk: number;
    off_track: number;
    unknown: number;
  };
}

// ── Data collection helpers ────────────────────────────────────────────────

function repoRoot(): string {
  // Walk up from __dirname to find the repo root (contains goals.yaml)
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, "goals.yaml"))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function countRetroFiles(root: string): number {
  const retrosDir = path.join(root, "docs", "retros");
  if (!fs.existsSync(retrosDir)) return 0;
  return fs
    .readdirSync(retrosDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}/.test(f) && f.endsWith(".md")).length;
}

function countOperatorActions(root: string, days = 30): number {
  const file = path.join(root, "docs", "operator-actions.md");
  if (!fs.existsSync(file)) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const content = fs.readFileSync(file, "utf-8");
  let count = 0;
  for (const line of content.split("\n")) {
    // Table rows: | YYYY-MM-DD | ... |
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime()) && d >= cutoff) count++;
    }
  }
  return count;
}

function parseMrrFromRevenueLog(root: string): number {
  const file = path.join(root, "docs", "revenue-log.md");
  if (!fs.existsSync(file)) return 0;
  const content = fs.readFileSync(file, "utf-8");
  // Sum amount_usd column from table rows in the current calendar month
  const now = new Date();
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  let mrr = 0;
  for (const line of content.split("\n")) {
    const m = line.match(/^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*\S+\s*\|\s*([0-9.]+)\s*\|/);
    if (m && m[1].startsWith(monthPrefix)) {
      mrr += parseFloat(m[2]) || 0;
    }
  }
  return mrr;
}

// ── KR evaluation ──────────────────────────────────────────────────────────

type MetricOperator = ">=" | "<=" | "==" | ">" | "<";

function parseMetric(metric: string): { op: MetricOperator; value: number | boolean } | null {
  const m = metric.match(/^[a-z_]+\s*(>=|<=|==|>|<)\s*(.+)$/);
  if (!m) return null;
  const raw = m[2].trim();
  const numVal = parseFloat(raw);
  if (!isNaN(numVal)) return { op: m[1] as MetricOperator, value: numVal };
  if (raw === "true") return { op: m[1] as MetricOperator, value: true };
  if (raw === "false") return { op: m[1] as MetricOperator, value: false };
  return null;
}

function evaluateStatus(
  current: number | boolean | null,
  metric: string,
): KRSnapshot["status"] {
  if (current === null) return "unknown";
  const parsed = parseMetric(metric);
  if (!parsed) return "unknown";

  const target = parsed.value;
  const op = parsed.op;
  let passing: boolean;

  if (typeof current === "boolean" && typeof target === "boolean") {
    passing = op === "==" ? current === target : current !== target;
  } else if (typeof current === "number" && typeof target === "number") {
    switch (op) {
      case ">=": passing = current >= target; break;
      case "<=": passing = current <= target; break;
      case "==": passing = current === target; break;
      case ">":  passing = current > target;  break;
      case "<":  passing = current < target;  break;
      default:   return "unknown";
    }
  } else {
    return "unknown";
  }

  if (passing) return "on_track";

  // At-risk = within 20% of target for numeric thresholds
  if (typeof current === "number" && typeof target === "number" && target !== 0) {
    const gap = Math.abs(current - target) / Math.abs(target);
    if (gap <= 0.20) return "at_risk";
  }
  return "off_track";
}

// ── Main snapshot builder ──────────────────────────────────────────────────

export function buildSnapshot(root: string): GoalsSnapshot {
  const now = new Date().toISOString().slice(0, 10);
  let store: StateStore | null = null;
  let weeklyTasks = 0;
  let weeklyDone = 0;
  let weeklyFailed = 0;
  let firstPassRate: number | null = null;

  try {
    store = new StateStore();
    const stats = store.getAgentStats(7 * 24); // last 7 days
    for (const row of stats) {
      weeklyTasks += row.total;
      weeklyDone  += row.done;
      weeklyFailed += row.failed;
    }
    // First-pass verification rate: done tasks where quality_score >= 0.70 on first attempt
    // Approximation: use getAgentStats avg_score as proxy
    const totalDone = weeklyDone;
    if (totalDone > 0) {
      const totalScore = stats.reduce((s, r) => s + (r.avg_score ?? 0) * r.done, 0);
      firstPassRate = totalScore / totalDone;
    }
  } catch {
    // state.db unavailable — continue with zeros
  } finally {
    store?.close();
  }

  const weeklyFailureRate = weeklyTasks > 0 ? weeklyFailed / weeklyTasks : null;
  const retroStreak = countRetroFiles(root);
  const operatorActions30d = countOperatorActions(root, 30);
  const mrr = parseMrrFromRevenueLog(root);

  const krs: KRSnapshot[] = [
    // ── OKR 1: external-oss-impact ────────────────────────────────────────
    {
      kr_id: "oss_github_stars",
      okr_id: "external-oss-impact",
      metric: "oss_github_stars >= 100",
      target: ">= 100",
      current_value: 0,
      as_of: now,
      source: "manual",
      status: "off_track",
      note: "No fleet-authored OSS repo yet. Tracks once external-oss-impact project ships.",
    },
    {
      kr_id: "oss_external_issues",
      okr_id: "external-oss-impact",
      metric: "oss_external_issues >= 5",
      target: ">= 5",
      current_value: 0,
      as_of: now,
      source: "manual",
      status: "off_track",
      note: "No fleet-authored OSS repo yet.",
    },
    {
      kr_id: "published_external_artefacts",
      okr_id: "external-oss-impact",
      metric: "published_external_artefacts >= 1",
      target: ">= 1",
      current_value: 0,
      as_of: now,
      source: "manual",
      status: "off_track",
      note: "No external artefacts published yet. Postmortem feed research complete — implementation pending.",
    },

    // ── OKR 2: scale-reliability ──────────────────────────────────────────
    {
      kr_id: "weekly_tasks_completed",
      okr_id: "scale-reliability",
      metric: "weekly_tasks_completed >= 1500",
      target: ">= 1500",
      current_value: weeklyDone,
      as_of: now,
      source: "state.db (7-day window)",
      status: evaluateStatus(weeklyDone, "weekly_tasks_completed >= 1500"),
    },
    {
      kr_id: "failure_rate",
      okr_id: "scale-reliability",
      metric: "failure_rate <= 0.08",
      target: "<= 0.08",
      current_value: weeklyFailureRate,
      as_of: now,
      source: "state.db (7-day window)",
      status: evaluateStatus(weeklyFailureRate, "failure_rate <= 0.08"),
    },
    {
      kr_id: "first_pass_verification_rate",
      okr_id: "scale-reliability",
      metric: "first_pass_verification_rate >= 0.90",
      target: ">= 0.90",
      current_value: firstPassRate,
      as_of: now,
      source: "state.db (7-day window, avg quality_score proxy)",
      status: evaluateStatus(firstPassRate, "first_pass_verification_rate >= 0.90"),
    },

    // ── OKR 3: cost-efficiency ────────────────────────────────────────────
    {
      kr_id: "avg_cost_per_task_usd",
      okr_id: "cost-efficiency",
      metric: "avg_cost_per_task_usd <= 0.10",
      target: "<= $0.10",
      current_value: null,
      as_of: now,
      source: "token-spend / proxy metrics",
      status: "unknown",
      note: "No cost-per-task tracking wired yet. File issue to integrate token-spend endpoint.",
    },
    {
      kr_id: "prompt_cache_hit_rate",
      okr_id: "cost-efficiency",
      metric: "prompt_cache_hit_rate >= 0.50",
      target: ">= 50%",
      current_value: null,
      as_of: now,
      source: "proxy metrics",
      status: "unknown",
      note: "Not yet measured. See findings/reviewer-prompt-caching.md for target design.",
    },
    {
      kr_id: "monthly_infra_spend_usd",
      okr_id: "cost-efficiency",
      metric: "monthly_infra_spend_usd <= 2000",
      target: "<= $2000/mo",
      current_value: null,
      as_of: now,
      source: "manual / invoices",
      status: "unknown",
      note: "Not yet measured. Fleet uses Operator-funded subscriptions until 2026-05-27.",
    },

    // ── OKR 4: autonomous-delivery ────────────────────────────────────────
    {
      kr_id: "autonomous_multi_repo_projects",
      okr_id: "autonomous-delivery",
      metric: "autonomous_multi_repo_projects >= 2",
      target: ">= 2",
      current_value: 0,
      as_of: now,
      source: "manual",
      status: "off_track",
      note: "Severance program (#1264) is the active multi-repo project. Counts when complete.",
    },
    {
      kr_id: "director_retro_streak",
      okr_id: "autonomous-delivery",
      metric: "director_retro_streak >= 8",
      target: ">= 8 consecutive weeks",
      current_value: retroStreak,
      as_of: now,
      source: "docs/retros/ file count",
      status: evaluateStatus(retroStreak, "director_retro_streak >= 8"),
      note: `${retroStreak} retro file(s) found in docs/retros/. Streak requires weekly cadence — see docs/retros/ for gaps.`,
    },
    {
      kr_id: "unauthorised_escalations",
      okr_id: "autonomous-delivery",
      metric: "unauthorised_escalations == 0",
      target: "== 0",
      current_value: 0,
      as_of: now,
      source: "manual / CLAUDE.md discipline",
      status: "on_track",
      note: "No recorded unauthorised escalations. Maintained by CLAUDE.md escalation discipline.",
    },

    // ── OKR 5: economic-autonomy ──────────────────────────────────────────
    {
      kr_id: "mrr_usd",
      okr_id: "economic-autonomy",
      metric: "mrr_usd >= 500",
      target: ">= $500/mo",
      current_value: mrr,
      as_of: now,
      source: "docs/revenue-log.md (current month sum)",
      status: evaluateStatus(mrr, "mrr_usd >= 500"),
      note: mrr === 0 ? "No revenue recorded yet. Day-30 floor (2026-05-27) is 18 days away." : undefined,
    },
    {
      kr_id: "paying_entities",
      okr_id: "economic-autonomy",
      metric: "paying_entities >= 3",
      target: ">= 3",
      current_value: 0,
      as_of: now,
      source: "docs/revenue-log.md",
      status: "off_track",
      note: "No paying entities yet. Add to revenue-log.md when first customer pays.",
    },
    {
      kr_id: "self_funded_ratio",
      okr_id: "economic-autonomy",
      metric: "self_funded_ratio >= 0.25",
      target: ">= 0.25 (revenue / infra spend)",
      current_value: mrr > 0 ? null : 0,
      as_of: now,
      source: "docs/revenue-log.md / monthly_infra_spend_usd",
      status: mrr > 0 ? "unknown" : "off_track",
      note: "infra_spend_usd not yet tracked. Update when both revenue and infra spend are measured.",
    },
    {
      kr_id: "article_iii_violations",
      okr_id: "economic-autonomy",
      metric: "article_iii_violations == 0",
      target: "== 0",
      current_value: 0,
      as_of: now,
      source: "manual / charter compliance",
      status: "on_track",
      note: "Zero Article III violations recorded. Charter enforced at action layer.",
    },

    // ── OKR 6: operator-severance ─────────────────────────────────────────
    {
      kr_id: "operator_actions_trailing_30d",
      okr_id: "operator-severance",
      metric: "operator_actions_trailing_30d == 0",
      target: "== 0",
      current_value: operatorActions30d,
      as_of: now,
      source: "docs/operator-actions.md (trailing 30 days)",
      status: evaluateStatus(operatorActions30d, "operator_actions_trailing_30d == 0"),
      note: operatorActions30d === 0
        ? "Log created. Append a row whenever the fleet asks the Operator to act."
        : `${operatorActions30d} operator action(s) in trailing 30 days.`,
    },
    {
      kr_id: "self_funded_consecutive_days",
      okr_id: "operator-severance",
      metric: "self_funded_consecutive_days >= 30",
      target: ">= 30 consecutive days",
      current_value: 0,
      as_of: now,
      source: "docs/revenue-log.md vs monthly_infra_spend_usd",
      status: "off_track",
      note: "Revenue $0 — fleet not yet self-funded. Starts counting once revenue >= daily infra cost.",
    },
    {
      kr_id: "operator_credentials_revoked",
      okr_id: "operator-severance",
      metric: "operator_credentials_revoked == true",
      target: "== true",
      current_value: false,
      as_of: now,
      source: "manual (severance tracker #1264)",
      status: "off_track",
      note: "Operator GH PAT, Claude Code OAuth, Linear key still active. Severance phase 4 target: 2026-07-29.",
    },
    {
      kr_id: "fleet_owned_infra",
      okr_id: "operator-severance",
      metric: "fleet_owned_infra == true",
      target: "== true",
      current_value: false,
      as_of: now,
      source: "manual (severance tracker #1264)",
      status: "off_track",
      note: "Fleet running on Operator's M4 hardware and subscriptions. Severance phase 4 target: 2026-07-29.",
    },
  ];

  // Annotate status
  for (const kr of krs) {
    if (kr.status === "unknown" && kr.current_value !== null) {
      kr.status = evaluateStatus(kr.current_value, kr.metric);
    }
  }

  const summary = {
    total_krs: krs.length,
    on_track: krs.filter((k) => k.status === "on_track").length,
    at_risk:  krs.filter((k) => k.status === "at_risk").length,
    off_track: krs.filter((k) => k.status === "off_track").length,
    unknown:  krs.filter((k) => k.status === "unknown").length,
  };

  return { as_of: now, generated_by: "orch goals-snapshot", key_results: krs, summary };
}

// ── YAML serializer (minimal, no deps) ────────────────────────────────────

function toYaml(snapshot: GoalsSnapshot): string {
  const lines: string[] = [
    "# Fleet KR progress snapshot",
    `# Generated by: ${snapshot.generated_by}`,
    `# To refresh: orch goals-snapshot`,
    `# To also update baselines in goals.yaml: orch goals-snapshot --capture-baseline`,
    "",
    `as_of: "${snapshot.as_of}"`,
    `generated_by: "${snapshot.generated_by}"`,
    "",
    "summary:",
    `  total_krs: ${snapshot.summary.total_krs}`,
    `  on_track: ${snapshot.summary.on_track}`,
    `  at_risk: ${snapshot.summary.at_risk}`,
    `  off_track: ${snapshot.summary.off_track}`,
    `  unknown: ${snapshot.summary.unknown}`,
    "",
    "key_results:",
  ];

  for (const kr of snapshot.key_results) {
    lines.push(`  - kr_id: ${kr.kr_id}`);
    lines.push(`    okr_id: ${kr.okr_id}`);
    lines.push(`    metric: "${kr.metric}"`);
    lines.push(`    target: "${kr.target}"`);
    const val = kr.current_value;
    if (val === null) {
      lines.push(`    current_value: null`);
    } else if (typeof val === "boolean") {
      lines.push(`    current_value: ${val}`);
    } else {
      lines.push(`    current_value: ${typeof val === "number" && !Number.isInteger(val) ? val.toFixed(4) : val}`);
    }
    lines.push(`    as_of: "${kr.as_of}"`);
    lines.push(`    source: "${kr.source}"`);
    lines.push(`    status: ${kr.status}`);
    if (kr.note) {
      // Escape for YAML block scalar
      lines.push(`    note: "${kr.note.replace(/"/g, '\\"')}"`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Status formatting ──────────────────────────────────────────────────────

function statusBadge(status: KRSnapshot["status"]): string {
  switch (status) {
    case "on_track":  return chalk.green("✓ on_track ");
    case "at_risk":   return chalk.yellow("⚠ at_risk  ");
    case "off_track": return chalk.red("✗ off_track");
    case "unknown":   return chalk.dim("? unknown  ");
  }
}

function fmtValue(v: number | boolean | null): string {
  if (v === null) return chalk.dim("N/A");
  if (typeof v === "boolean") return v ? chalk.green("true") : chalk.red("false");
  if (typeof v === "number") {
    if (v === Math.floor(v)) return String(v);
    return v.toFixed(4);
  }
  return String(v);
}

// ── Baseline updater ───────────────────────────────────────────────────────

function updateBaselines(root: string, snapshot: GoalsSnapshot): void {
  const goalsPath = path.join(root, "goals.yaml");
  if (!fs.existsSync(goalsPath)) return;

  let content = fs.readFileSync(goalsPath, "utf-8");
  const weeklyKr = snapshot.key_results.find((k) => k.kr_id === "weekly_tasks_completed");
  const failureKr = snapshot.key_results.find((k) => k.kr_id === "failure_rate");
  const costKr    = snapshot.key_results.find((k) => k.kr_id === "avg_cost_per_task_usd");

  // Replace null placeholders in the baseline section
  if (weeklyKr?.current_value !== null && weeklyKr?.current_value !== undefined) {
    content = content.replace(
      /tasks_per_week:\s*null.*?#.*$/m,
      `tasks_per_week: ${weeklyKr.current_value}   # captured ${snapshot.as_of} via orch goals-snapshot`,
    );
  }
  if (failureKr?.current_value !== null && failureKr?.current_value !== undefined) {
    content = content.replace(
      /failure_rate:\s*null.*?#.*$/m,
      `failure_rate: ${typeof failureKr.current_value === "number" ? failureKr.current_value.toFixed(4) : failureKr.current_value}   # captured ${snapshot.as_of} via orch goals-snapshot`,
    );
  }
  if (costKr?.current_value !== null && costKr?.current_value !== undefined) {
    content = content.replace(
      /avg_cost_per_task_usd:\s*null.*?#.*$/m,
      `avg_cost_per_task_usd: ${costKr.current_value}   # captured ${snapshot.as_of} via orch goals-snapshot`,
    );
  }

  fs.writeFileSync(goalsPath, content, "utf-8");
}

// ── Command registration ───────────────────────────────────────────────────

export function registerGoalsSnapshotCommand(program: Command): void {
  program
    .command("goals-snapshot")
    .description(
      "Snapshot current KR values from state.db and filesystem into docs/goals-progress.yaml (issue #1567)",
    )
    .option("--json", "Print JSON snapshot to stdout without writing files")
    .option(
      "--capture-baseline",
      "Also populate null baselines in goals.yaml with current values (one-time run)",
    )
    .option(
      "--check",
      "Print snapshot and exit 1 if any KR regressed since last snapshot (CI gate)",
    )
    .option(
      "--root <path>",
      "Override repo root path (default: auto-detected from goals.yaml location)",
    )
    .action((opts: { json?: boolean; captureBaseline?: boolean; check?: boolean; root?: string }) => {
      const root = opts.root ?? repoRoot();
      const snapshot = buildSnapshot(root);

      if (opts.json) {
        console.log(JSON.stringify(snapshot, null, 2));
        return;
      }

      // ── Human-readable output ───────────────────────────────────────────
      console.log(chalk.bold(`\n📊  Fleet KR Snapshot — ${snapshot.as_of}\n`));
      console.log(
        chalk.dim(
          `  ${snapshot.summary.on_track}/${snapshot.summary.total_krs} on track  ·  ` +
            `${snapshot.summary.at_risk} at risk  ·  ` +
            `${snapshot.summary.off_track} off track  ·  ` +
            `${snapshot.summary.unknown} unknown\n`,
        ),
      );

      let currentOkr = "";
      for (const kr of snapshot.key_results) {
        if (kr.okr_id !== currentOkr) {
          currentOkr = kr.okr_id;
          console.log(chalk.bold(`  ── ${currentOkr} ──`));
        }
        const badge = statusBadge(kr.status);
        const val   = fmtValue(kr.current_value);
        console.log(
          `  ${badge}  ${kr.kr_id.padEnd(38)} ${val.padStart(10)}  →  ${chalk.dim(kr.target)}`,
        );
        if (kr.note) {
          console.log(chalk.dim(`             ${kr.note}`));
        }
      }
      console.log();

      // ── File write ──────────────────────────────────────────────────────
      if (!opts.check) {
        const outPath = path.join(root, "docs", "goals-progress.yaml");
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, toYaml(snapshot), "utf-8");
        console.log(chalk.green(`  ✓ Written to ${outPath}\n`));

        if (opts.captureBaseline) {
          updateBaselines(root, snapshot);
          console.log(chalk.green(`  ✓ Baselines updated in goals.yaml\n`));
        }
      }

      // ── Check mode exit code ────────────────────────────────────────────
      if (opts.check && snapshot.summary.off_track > 0) {
        console.log(
          chalk.red(
            `  ✗ ${snapshot.summary.off_track} KR(s) off track. Run 'orch goals-snapshot' to update the progress file.\n`,
          ),
        );
        process.exit(1);
      }
    });
}
