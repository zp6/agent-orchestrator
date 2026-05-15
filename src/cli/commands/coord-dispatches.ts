/**
 * `orch coord-dispatches` — audit the per-repo "What to implement" payloads
 * sent to peer agents during multi-repo coordinated changes.
 *
 * Lists recent coordination groups with each child agent's `description`
 * payload, flagging entries that:
 *   - hit the `NO_CODE_CHANGES_FALLBACK` sentinel (validation rejected)
 *   - have a description shorter than 30 characters
 *
 * Also surfaces the underlying validation rejection log
 * (`coordination_dispatch_audit`) so operators can see how often
 * `validateChangeSetDescription` is firing in production and which repos /
 * reasons dominate.
 *
 * See issue #1530 (introspection surface) and agent-reviewer#668 (the
 * truncation bug that motivated the validation defense).
 */
import type { Command } from "commander";
import chalk from "chalk";
import { StateStore } from "../../state/store.js";
import { NO_CODE_CHANGES_FALLBACK, type MultiRepoChangeSet } from "../../orchestrator/multi-repo-coordinator.js";

const SHORT_DESCRIPTION_THRESHOLD = 30;

function formatAge(isoTimestamp: string): string {
  const ms = Date.now() - new Date(isoTimestamp).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function statusColour(status: string): string {
  switch (status) {
    case "merged":        return chalk.green(status);
    case "ready_to_merge":
    case "in_progress":   return chalk.cyan(status);
    case "merging":       return chalk.blue(status);
    case "pending":       return chalk.yellow(status);
    case "failed":
    case "rolled_back":   return chalk.red(status);
    default:              return status;
  }
}

function reasonColour(reason: string): string {
  switch (reason) {
    case "empty":              return chalk.red(reason);
    case "antibody_fragment":  return chalk.magenta(reason);
    case "truncated":          return chalk.yellow(reason);
    case "token_missing":      return chalk.yellow(reason);
    default:                   return reason;
  }
}

interface ChangeSetFlag {
  kind: "fallback" | "short";
  detail?: string;
}

/**
 * Decide whether a per-repo change set warrants a flag in the audit listing.
 * Exported for tests so the contract is explicit.
 */
export function flagChangeSet(cs: MultiRepoChangeSet): ChangeSetFlag | null {
  const trimmed = (cs.description ?? "").trim();
  if (trimmed === NO_CODE_CHANGES_FALLBACK) {
    return { kind: "fallback" };
  }
  if (trimmed.length < SHORT_DESCRIPTION_THRESHOLD) {
    return { kind: "short", detail: `${trimmed.length} chars` };
  }
  return null;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export function registerCoordDispatchesCommand(program: Command): void {
  program
    .command("coord-dispatches")
    .description(
      "Audit recent coordinated-change dispatches: per-repo 'What to implement' payloads + validation rejections (issue #1530)",
    )
    .option("-n, --limit <n>", "Number of coordination groups to show", "20")
    .option("--status <s>", "Filter by group status (pending, in_progress, ready_to_merge, merging, merged, rolled_back, failed)")
    .option("--repo <r>", "Filter audit entries by repo (e.g. rapartlu/agent-reviewer)")
    .option("--audit-only", "Show only the validation-rejection audit log")
    .option("--no-audit", "Hide the validation-rejection audit log section")
    .option("--json", "Emit newline-delimited JSON instead of a formatted table")
    .action(
      (opts: {
        limit: string;
        status?: string;
        repo?: string;
        auditOnly?: boolean;
        audit?: boolean;
        json?: boolean;
      }) => {
        const limit = parseInt(opts.limit, 10);
        if (isNaN(limit) || limit <= 0) {
          console.error(chalk.red("Error: --limit must be a positive integer."));
          process.exit(1);
        }

        let store: StateStore;
        try {
          store = new StateStore();
        } catch (err) {
          console.error(
            chalk.red("Could not open state database:"),
            err instanceof Error ? err.message : String(err),
          );
          process.exit(1);
        }

        let groups: ReturnType<StateStore["listRecentCoordinationGroups"]> = [];
        let audits: ReturnType<StateStore["listCoordinationDispatchAudits"]> = [];
        let reasonCounts: Record<string, number> = {};
        try {
          if (!opts.auditOnly) {
            groups = store.listRecentCoordinationGroups({ limit, status: opts.status });
          }
          if (opts.audit !== false || opts.auditOnly) {
            audits = store.listCoordinationDispatchAudits({
              limit: Math.max(limit, 50),
              repo: opts.repo,
            });
            // Last 7d window for the rejection-rate summary
            const sinceISO = new Date(Date.now() - 7 * 86_400_000).toISOString();
            reasonCounts = store.countCoordinationDispatchAuditsByReason({ sinceISO });
          }
        } finally {
          store.close();
        }

        if (opts.json) {
          for (const g of groups) {
            console.log(JSON.stringify({ kind: "group", ...g }));
          }
          for (const a of audits) {
            console.log(JSON.stringify({ kind: "audit", ...a }));
          }
          return;
        }

        if (!opts.auditOnly) {
          renderGroups(groups, opts.repo);
        }

        if (opts.audit !== false || opts.auditOnly) {
          renderAudits(audits, reasonCounts);
        }
      },
    );
}

function renderGroups(
  groups: ReturnType<StateStore["listRecentCoordinationGroups"]>,
  repoFilter?: string,
): void {
  console.log(chalk.bold("\n● Coordinated-change dispatches\n"));

  if (groups.length === 0) {
    console.log(chalk.dim("  No coordination groups recorded yet. They are created when a"));
    console.log(chalk.dim("  completed implementation task triggers cross-repo work.\n"));
    return;
  }

  for (const g of groups) {
    const created = `${chalk.dim(g.createdAt.slice(0, 16).replace("T", " "))}  (${formatAge(g.createdAt)})`;
    console.log(`  ${chalk.bold(g.id)}  ${statusColour(g.status)}  ${created}`);
    if (g.parentSourceRef) {
      console.log(`    ${chalk.dim("parent:")} ${chalk.cyan(g.parentSourceRef)}`);
    }
    console.log(`    ${chalk.dim("parent task:")} ${g.parentTaskId}`);

    const changeSets = g.changeSets as MultiRepoChangeSet[];
    const filtered = repoFilter
      ? changeSets.filter((cs) => cs.repo === repoFilter)
      : changeSets;

    if (filtered.length === 0) {
      console.log(chalk.dim(`    (no change sets match repo=${repoFilter})`));
    }

    for (const cs of filtered.sort((a, b) => a.mergeOrder - b.mergeOrder)) {
      const flag = flagChangeSet(cs);
      const flagBadge = flag
        ? flag.kind === "fallback"
          ? chalk.red(" ⚠ FALLBACK")
          : chalk.yellow(` ⚠ short (${flag.detail})`)
        : "";
      const prNum = g.childPRNumbers[cs.repo];
      const childTaskId = g.childTaskIds[cs.repo];
      const prSuffix = prNum
        ? ` ${chalk.dim("PR:")} ${chalk.cyan(`${cs.repo}#${prNum}`)}`
        : "";
      const taskSuffix = childTaskId ? ` ${chalk.dim("task:")} ${childTaskId.slice(0, 8)}` : "";
      console.log(
        `    ${chalk.dim(`order ${cs.mergeOrder}`)} ${chalk.bold(cs.repo)} → ${cs.agentName}${flagBadge}${prSuffix}${taskSuffix}`,
      );
      const desc = (cs.description ?? "").trim();
      const oneLine = truncate(desc.replace(/\s+/g, " "), 200);
      const shown = oneLine.length === 0 ? chalk.dim("(empty)") : oneLine;
      console.log(`      ${chalk.dim("payload:")} ${shown}`);
    }
    console.log();
  }

  console.log(chalk.dim(`  Showing ${groups.length} group${groups.length === 1 ? "" : "s"}.`));
  console.log();
}

function renderAudits(
  audits: ReturnType<StateStore["listCoordinationDispatchAudits"]>,
  reasonCounts: Record<string, number>,
): void {
  console.log(chalk.bold("● Validation rejection log (coordination_dispatch_audit)\n"));

  const totalLast7d = Object.values(reasonCounts).reduce((a, b) => a + b, 0);
  if (totalLast7d > 0) {
    const breakdown = Object.entries(reasonCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reasonColour(reason)}=${n}`)
      .join(" ");
    console.log(chalk.dim(`  Last 7d: ${totalLast7d} rejection${totalLast7d === 1 ? "" : "s"}  ${breakdown}`));
    console.log();
  }

  if (audits.length === 0) {
    console.log(chalk.dim("  No audit entries recorded.\n"));
    return;
  }

  console.log(
    chalk.dim(
      `  ${"When".padEnd(18)} ${"Reason".padEnd(20)} ${"Repo".padEnd(36)} Snippet`,
    ),
  );
  console.log(chalk.dim("  " + "─".repeat(120)));

  for (const a of audits) {
    const ts = a.createdAt.slice(0, 16).replace("T", " ");
    // Pad raw values first so the columns line up despite ANSI colour codes.
    const reasonPad = a.reason.padEnd(20);
    const repoPad = a.repo.padEnd(36);
    const snippet = truncate((a.rawSnippet ?? "").replace(/\s+/g, " "), 100);
    const tokenInfo = a.matchedToken ? chalk.dim(` (token=${a.matchedToken})`) : "";
    console.log(
      `  ${chalk.dim(ts)}  ${reasonColour(reasonPad)} ${chalk.cyan(repoPad)} ${snippet}${tokenInfo}`,
    );
    if (a.parentSourceRef) {
      console.log(`  ${" ".repeat(18)}  ${chalk.dim("parent:")} ${a.parentSourceRef}`);
    }
  }

  console.log();
  console.log(chalk.dim(`  Showing ${audits.length} audit entr${audits.length === 1 ? "y" : "ies"}.`));
  console.log();
}
