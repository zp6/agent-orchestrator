/**
 * `orch fleet-actions` — CLI for the producer/critic action ledger.
 *
 * Schema: docs/active-fleet-actions-schema.md
 * File:   docs/active-fleet-actions.yaml
 *
 * Hustle proposes actions; auditor reviews them; hustle executes only the
 * approved ones. Both agents read and write this file. The CLI is for operator
 * convenience and local automation; agents running in containers will write
 * via `gh api` to the repo's contents endpoint.
 */

import type { Command } from "commander";
import chalk from "chalk";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createHash } from "node:crypto";

const LEDGER_PATH = resolve(process.cwd(), "docs/active-fleet-actions.yaml");

export type ActionType =
  | "github-pr-open"
  | "outreach-dm"
  | "bounty-submission"
  | "demo-repo-update"
  | "content-post";

export type ActionStatus =
  | "proposed"
  | "under_review"
  | "approved"
  | "rejected"
  | "executing"
  | "executed"
  | "abandoned";

export type ReviewDecision = "approve" | "hold" | "reject";

export interface FleetAction {
  id: string;
  proposed_by: string;
  proposed_at: string;
  type: ActionType;
  target: string;
  summary: string;
  reasoning: string;
  expected_value: {
    currency: string;
    amount: number;
    confidence: "low" | "medium" | "high";
  };
  source_signals: string[];
  okr_alignment: string[];
  status: ActionStatus;
  auditor_review: {
    reviewed_at: string | null;
    reviewer: string | null;
    decision: ReviewDecision | null;
    reasoning: string | null;
    conditions: string[];
  };
  execution: {
    started_at: string | null;
    completed_at: string | null;
    artifact_url: string | null;
    outcome: "success" | "failure" | null;
    revenue_received_usd: number | null;
  };
}

interface Ledger {
  schema_version: number;
  generated_at: string | null;
  actions: FleetAction[];
}

function readLedger(): Ledger {
  if (!existsSync(LEDGER_PATH)) {
    return { schema_version: 1, generated_at: null, actions: [] };
  }
  const raw = readFileSync(LEDGER_PATH, "utf-8");
  const parsed = parseYaml(raw) as Ledger | null;
  if (!parsed) return { schema_version: 1, generated_at: null, actions: [] };
  if (!Array.isArray(parsed.actions)) parsed.actions = [];
  return parsed;
}

function writeLedger(ledger: Ledger): void {
  ledger.generated_at = new Date().toISOString();
  const yaml = stringifyYaml(ledger, {
    lineWidth: 0,
    blockQuote: "literal",
  });
  const header =
    "# Active fleet actions — shared friction surface for the producer/critic loop.\n" +
    "# Hustle proposes actions; auditor reviews them; hustle executes only approved actions.\n" +
    "# Schema: docs/active-fleet-actions-schema.md\n" +
    "# CLI: orch fleet-actions {list,propose,review,execute,history,stats}\n\n";
  writeFileSync(LEDGER_PATH, header + yaml);
}

function generateActionId(proposedBy: string, summary: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const shortHash = createHash("sha256")
    .update(`${proposedBy}|${summary}|${Date.now()}`)
    .digest("hex")
    .slice(0, 8);
  return `${proposedBy}-${ts}-${shortHash}`;
}

function statusColor(status: ActionStatus): (s: string) => string {
  switch (status) {
    case "approved":
    case "executed":
      return chalk.green;
    case "rejected":
    case "abandoned":
      return chalk.red;
    case "executing":
    case "under_review":
      return chalk.yellow;
    case "proposed":
      return chalk.cyan;
  }
}

function decisionColor(decision: ReviewDecision | null): (s: string) => string {
  if (!decision) return chalk.dim;
  if (decision === "approve") return chalk.green;
  if (decision === "reject") return chalk.red;
  return chalk.yellow;
}

function ageOf(isoString: string): string {
  const ms = Date.now() - new Date(isoString).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  return `${d}d`;
}

export function registerFleetActionsCommand(program: Command): void {
  const cmd = program
    .command("fleet-actions")
    .description("Manage the producer/critic action ledger (docs/active-fleet-actions.yaml)");

  cmd
    .command("list")
    .description("List actions in the ledger")
    .option("--status <s>", "filter by status (proposed, approved, executed, etc.)")
    .option("--type <t>", "filter by type")
    .option("--limit <n>", "max rows", "20")
    .option("--json", "output JSON")
    .action((opts: { status?: string; type?: string; limit: string; json?: boolean }) => {
      const ledger = readLedger();
      let actions = ledger.actions;
      if (opts.status) actions = actions.filter((a) => a.status === opts.status);
      if (opts.type) actions = actions.filter((a) => a.type === opts.type);
      actions = actions.slice(-Number(opts.limit));

      if (opts.json) {
        console.log(JSON.stringify(actions, null, 2));
        return;
      }

      if (actions.length === 0) {
        console.log(chalk.dim("  (no matching actions)"));
        return;
      }

      console.log(chalk.bold("\n● Fleet actions\n"));
      console.log(
        chalk.bold("STATUS".padEnd(13)) +
          chalk.bold("DECISION".padEnd(10)) +
          chalk.bold("AGE".padEnd(6)) +
          chalk.bold("TYPE".padEnd(20)) +
          chalk.bold("TARGET".padEnd(35)) +
          chalk.bold("SUMMARY"),
      );
      console.log("─".repeat(140));
      for (const a of actions) {
        const status = statusColor(a.status)(a.status.padEnd(13));
        const decision = decisionColor(a.auditor_review.decision)(
          (a.auditor_review.decision ?? "—").padEnd(10),
        );
        const age = chalk.dim(ageOf(a.proposed_at).padEnd(6));
        const type = a.type.padEnd(20);
        const target = (a.target.length > 33 ? a.target.slice(0, 32) + "…" : a.target).padEnd(35);
        const summary = a.summary.length > 60 ? a.summary.slice(0, 59) + "…" : a.summary;
        console.log(`${status}${decision}${age}${type}${target}${summary}`);
      }
      console.log();
    });

  cmd
    .command("propose")
    .description("Propose a new action (used by hustle agent; humans can also use)")
    .requiredOption("--type <type>", "action type")
    .requiredOption("--target <target>", "repo/url/handle the action targets")
    .requiredOption("--summary <s>", "one-line description")
    .requiredOption("--reasoning <r>", "multi-line reasoning")
    .option("--expected-value <usd>", "expected payout USD", "0")
    .option("--confidence <c>", "low|medium|high", "low")
    .option("--source-signal <s>", "evidence source (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--okr <okr-id>", "OKR alignment (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--proposed-by <agent>", "agent name", "hustle-agent")
    .option("--json", "output the created action as JSON")
    .action(
      (opts: {
        type: string;
        target: string;
        summary: string;
        reasoning: string;
        expectedValue: string;
        confidence: string;
        sourceSignal: string[];
        okr: string[];
        proposedBy: string;
        json?: boolean;
      }) => {
        const ledger = readLedger();
        const action: FleetAction = {
          id: generateActionId(opts.proposedBy, opts.summary),
          proposed_by: opts.proposedBy,
          proposed_at: new Date().toISOString(),
          type: opts.type as ActionType,
          target: opts.target,
          summary: opts.summary,
          reasoning: opts.reasoning,
          expected_value: {
            currency: "USD",
            amount: Number(opts.expectedValue),
            confidence: opts.confidence as "low" | "medium" | "high",
          },
          source_signals: opts.sourceSignal,
          okr_alignment: opts.okr,
          status: "proposed",
          auditor_review: {
            reviewed_at: null,
            reviewer: null,
            decision: null,
            reasoning: null,
            conditions: [],
          },
          execution: {
            started_at: null,
            completed_at: null,
            artifact_url: null,
            outcome: null,
            revenue_received_usd: null,
          },
        };
        ledger.actions.push(action);
        writeLedger(ledger);
        if (opts.json) {
          console.log(JSON.stringify(action, null, 2));
        } else {
          console.log(chalk.green(`✓ proposed ${action.id}`));
          console.log(chalk.dim(`  status=${action.status} type=${action.type} target=${action.target}`));
        }
      },
    );

  cmd
    .command("review <id>")
    .description("Auditor records a review decision on a proposed action")
    .requiredOption("--decision <d>", "approve|hold|reject")
    .requiredOption("--reasoning <r>", "why this decision")
    .option("--condition <c>", "approval condition (repeatable)", (val, prev: string[]) => [...prev, val], [] as string[])
    .option("--reviewer <agent>", "agent name", "auditor-agent")
    .option("--json", "output the updated action as JSON")
    .action(
      (
        id: string,
        opts: {
          decision: string;
          reasoning: string;
          condition: string[];
          reviewer: string;
          json?: boolean;
        },
      ) => {
        const ledger = readLedger();
        const action = ledger.actions.find((a) => a.id === id);
        if (!action) {
          console.error(chalk.red(`Action ${id} not found`));
          process.exit(1);
        }
        if (action.status !== "proposed" && action.status !== "under_review") {
          console.error(
            chalk.red(`Action ${id} cannot be reviewed (status=${action.status})`),
          );
          process.exit(1);
        }
        action.auditor_review.reviewed_at = new Date().toISOString();
        action.auditor_review.reviewer = opts.reviewer;
        action.auditor_review.decision = opts.decision as ReviewDecision;
        action.auditor_review.reasoning = opts.reasoning;
        action.auditor_review.conditions = opts.condition;
        if (opts.decision === "approve") action.status = "approved";
        else if (opts.decision === "reject") action.status = "rejected";
        else action.status = "under_review";
        writeLedger(ledger);
        if (opts.json) {
          console.log(JSON.stringify(action, null, 2));
        } else {
          console.log(
            decisionColor(opts.decision as ReviewDecision)(
              `${opts.decision === "approve" ? "✓" : opts.decision === "reject" ? "✗" : "⏸"} ${action.id} → ${opts.decision}`,
            ),
          );
          console.log(chalk.dim(`  reasoning: ${opts.reasoning}`));
        }
      },
    );

  cmd
    .command("execute <id>")
    .description("Mark an approved action as executing or executed (used by hustle)")
    .option("--artifact-url <url>", "PR / post / submission URL")
    .option("--outcome <o>", "success|failure")
    .option("--revenue <usd>", "revenue received in USD")
    .option("--start", "mark as executing")
    .option("--complete", "mark as executed")
    .option("--json", "output the updated action as JSON")
    .action(
      (
        id: string,
        opts: {
          artifactUrl?: string;
          outcome?: string;
          revenue?: string;
          start?: boolean;
          complete?: boolean;
          json?: boolean;
        },
      ) => {
        const ledger = readLedger();
        const action = ledger.actions.find((a) => a.id === id);
        if (!action) {
          console.error(chalk.red(`Action ${id} not found`));
          process.exit(1);
        }
        if (opts.start) {
          if (action.status !== "approved") {
            console.error(
              chalk.red(`Cannot start ${id} — current status is ${action.status}, must be approved`),
            );
            process.exit(1);
          }
          action.status = "executing";
          action.execution.started_at = new Date().toISOString();
        }
        if (opts.complete) {
          action.status = "executed";
          action.execution.completed_at = new Date().toISOString();
          if (opts.artifactUrl) action.execution.artifact_url = opts.artifactUrl;
          if (opts.outcome) action.execution.outcome = opts.outcome as "success" | "failure";
          if (opts.revenue) action.execution.revenue_received_usd = Number(opts.revenue);
        }
        writeLedger(ledger);
        if (opts.json) {
          console.log(JSON.stringify(action, null, 2));
        } else {
          console.log(chalk.green(`✓ ${action.id} → ${action.status}`));
          if (action.execution.artifact_url) {
            console.log(chalk.dim(`  artifact: ${action.execution.artifact_url}`));
          }
        }
      },
    );

  cmd
    .command("stats")
    .description("Show producer/critic loop KPIs")
    .option("--days <n>", "trailing window in days", "1")
    .option("--json", "output JSON")
    .action((opts: { days: string; json?: boolean }) => {
      const ledger = readLedger();
      const windowMs = Number(opts.days) * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - windowMs;
      const recent = ledger.actions.filter(
        (a) => new Date(a.proposed_at).getTime() >= cutoff,
      );
      const proposedCount = recent.length;
      const reviewed = recent.filter((a) => a.auditor_review.decision !== null);
      const approved = recent.filter((a) => a.auditor_review.decision === "approve");
      const held = recent.filter((a) => a.auditor_review.decision === "hold");
      const rejected = recent.filter((a) => a.auditor_review.decision === "reject");
      const executed = recent.filter((a) => a.status === "executed");
      const executionRate =
        approved.length === 0
          ? null
          : executed.length / approved.length;

      // Pipeline breakdown across ALL actions (not just the window) — gives
      // a quick view of work-in-progress that lets you spot pipeline stalls
      // (e.g. many "proposed" piling up = auditor isn't running).
      const pipeline = {
        proposed: ledger.actions.filter((a) => a.status === "proposed").length,
        under_review: ledger.actions.filter((a) => a.status === "under_review").length,
        approved: ledger.actions.filter((a) => a.status === "approved").length,
        rejected: ledger.actions.filter((a) => a.status === "rejected").length,
        executing: ledger.actions.filter((a) => a.status === "executing").length,
        executed: ledger.actions.filter((a) => a.status === "executed").length,
        abandoned: ledger.actions.filter((a) => a.status === "abandoned").length,
      };

      // Last-activity timestamps — when did each stage of the loop last fire?
      // Used to answer "is the producer/critic loop alive RIGHT NOW?" without
      // having to dig into the ledger or daemon logs.
      const allByProposedAt = [...ledger.actions].sort(
        (a, b) => new Date(b.proposed_at).getTime() - new Date(a.proposed_at).getTime(),
      );
      const reviewedAll = ledger.actions.filter((a) => a.auditor_review.reviewed_at);
      const executedAll = ledger.actions.filter((a) => a.execution.completed_at);
      const lastProposalAt = allByProposedAt[0]?.proposed_at ?? null;
      const lastReviewAt = reviewedAll
        .map((a) => a.auditor_review.reviewed_at as string)
        .sort()
        .reverse()[0] ?? null;
      const lastExecutionAt = executedAll
        .map((a) => a.execution.completed_at as string)
        .sort()
        .reverse()[0] ?? null;

      const stats = {
        window_days: Number(opts.days),
        hustle_actions_proposed: proposedCount,
        auditor_reviews_completed: reviewed.length,
        auditor_approved: approved.length,
        auditor_holds: held.length,
        auditor_rejects: rejected.length,
        approved_action_execution_rate: executionRate,
        executed_actions: executed.length,
        pipeline,
        last_proposal_at: lastProposalAt,
        last_review_at: lastReviewAt,
        last_execution_at: lastExecutionAt,
      };

      if (opts.json) {
        console.log(JSON.stringify(stats, null, 2));
        return;
      }

      console.log(chalk.bold(`\n● Fleet-actions stats (trailing ${opts.days}d)\n`));
      const fmt = (label: string, value: string | number | null, target?: string) => {
        const v = value === null ? "—" : String(value);
        console.log(`  ${label.padEnd(38)} ${chalk.cyan(v.padStart(8))}${target ? chalk.dim("  " + target) : ""}`);
      };
      fmt("hustle_actions_proposed", proposedCount, "(target: ≥3)");
      fmt("auditor_reviews_completed", reviewed.length);
      fmt("auditor_holds", held.length, "(target: 1-5, NOT zero)");
      fmt("auditor_rejects", rejected.length);
      fmt(
        "approved_action_execution_rate",
        executionRate === null ? null : `${(executionRate * 100).toFixed(0)}%`,
        "(target: ≥80%)",
      );

      console.log(chalk.bold("\n  Pipeline (all-time)"));
      const fmtPipe = (label: string, value: number) => {
        const colour = value > 0 ? chalk.cyan : chalk.dim;
        console.log(`  ${label.padEnd(38)} ${colour(String(value).padStart(8))}`);
      };
      fmtPipe("proposed (awaiting auditor)", pipeline.proposed);
      fmtPipe("under_review", pipeline.under_review);
      fmtPipe("approved (awaiting executor)", pipeline.approved);
      fmtPipe("rejected", pipeline.rejected);
      fmtPipe("executing", pipeline.executing);
      fmtPipe("executed", pipeline.executed);
      fmtPipe("abandoned", pipeline.abandoned);

      console.log(chalk.bold("\n  Last activity"));
      const ago = (iso: string | null): string => {
        if (!iso) return chalk.dim("never");
        const ms = Date.now() - new Date(iso).getTime();
        const min = Math.floor(ms / 60000);
        if (min < 60) return chalk.cyan(`${min}m ago`);
        const hr = Math.floor(min / 60);
        if (hr < 48) return chalk.cyan(`${hr}h ago`);
        return chalk.cyan(`${Math.floor(hr / 24)}d ago`);
      };
      console.log(`  ${"last_proposal".padEnd(38)} ${ago(lastProposalAt).padStart(8)}`);
      console.log(`  ${"last_review".padEnd(38)} ${ago(lastReviewAt).padStart(8)}`);
      console.log(`  ${"last_execution".padEnd(38)} ${ago(lastExecutionAt).padStart(8)}`);
      console.log();
    });

  cmd
    .command("history")
    .description("Show executed actions and outcomes")
    .option("--days <n>", "trailing window", "7")
    .option("--limit <n>", "max rows", "20")
    .action((opts: { days: string; limit: string }) => {
      const ledger = readLedger();
      const cutoff = Date.now() - Number(opts.days) * 24 * 60 * 60 * 1000;
      const executed = ledger.actions
        .filter((a) => a.status === "executed" || a.status === "abandoned")
        .filter((a) => {
          const ts = a.execution.completed_at ?? a.proposed_at;
          return new Date(ts).getTime() >= cutoff;
        })
        .slice(-Number(opts.limit));

      if (executed.length === 0) {
        console.log(chalk.dim("  (no completed actions in window)"));
        return;
      }

      console.log(chalk.bold(`\n● Executed actions (last ${opts.days}d)\n`));
      for (const a of executed) {
        const outcome = a.execution.outcome ?? a.status;
        const outcomeColored =
          outcome === "success" ? chalk.green(outcome) : chalk.red(outcome);
        const revenue = a.execution.revenue_received_usd
          ? chalk.green(`$${a.execution.revenue_received_usd}`)
          : chalk.dim("$0");
        console.log(`  ${chalk.bold(a.id)}`);
        console.log(`    ${outcomeColored}  ${revenue}  ${a.summary}`);
        if (a.execution.artifact_url) {
          console.log(chalk.dim(`    ${a.execution.artifact_url}`));
        }
        console.log();
      }
    });
}
