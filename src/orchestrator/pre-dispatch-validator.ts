import type { OrchestratorConfig } from "../config/schema.js";
import type {
  DispatchValidationCheck,
  DispatchValidationOutcome,
  StateStore,
} from "../state/store.js";
import { cachedGetIssueState } from "../triggers/issue-state-bridge.js";
import { checkDuplicate } from "../triggers/duplicate-guard.js";
import {
  findApprovedPRForIssue,
  findBranchForIssue,
  findExistingPRsForIssue,
  type LinkedPR,
} from "../triggers/github.js";
import { DEFAULT_ESCALATION_RETRY_LIMIT } from "../triggers/reporters.js";

export interface PreDispatchIssueRef {
  repo: string;
  number: number;
}

export interface PreDispatchValidationResult {
  outcome: DispatchValidationOutcome;
  source: string;
  sourceRef: string;
  agentName: string;
  repo: string;
  issueNumber: number;
  checks: DispatchValidationCheck[];
  failureCheck: string | null;
  failureCode: string | null;
  failureReason: string | null;
  blockingPRNumber: number | null;
  draftPR: LinkedPR | null;
  existingBranch: string | null;
}

function makePassedCheck(
  name: string,
  code: string,
  detail: string,
): DispatchValidationCheck {
  return { name, status: "passed", code, detail };
}

function makeInfoCheck(
  name: string,
  code: string,
  detail: string,
): DispatchValidationCheck {
  return { name, status: "info", code, detail };
}

function makeFailedResult(
  base: Omit<PreDispatchValidationResult, "outcome" | "failureCheck" | "failureCode" | "failureReason">,
  name: string,
  code: string,
  detail: string,
): PreDispatchValidationResult {
  return {
    ...base,
    outcome: "blocked",
    failureCheck: name,
    failureCode: code,
    failureReason: detail,
    blockingPRNumber: null,
    checks: [...base.checks, { name, status: "failed", code, detail }],
  };
}

/**
 * Run the authoritative GitHub issue pre-dispatch checklist and persist the
 * structured result to the state store.
 */
export function runGitHubPreDispatchValidation(params: {
  config: OrchestratorConfig;
  store: StateStore;
  source: string;
  agentName: string;
  issue: PreDispatchIssueRef;
  allowDuplicateRecencyBypass?: boolean;
}): PreDispatchValidationResult {
  const { config, store, source, agentName, issue, allowDuplicateRecencyBypass = false } = params;
  const sourceRef = `${issue.repo}#${issue.number}`;
  const checks: DispatchValidationCheck[] = [];
  const base = {
    source,
    sourceRef,
    agentName,
    repo: issue.repo,
    issueNumber: issue.number,
    checks,
    blockingPRNumber: null as number | null,
    draftPR: null as LinkedPR | null,
    existingBranch: null as string | null,
  };

  const agent = config.agents[agentName];
  if (!agent?.github) {
    const failed = makeFailedResult(
      base,
      "issue_ownership",
      "missing_agent_github",
      `agent "${agentName}" has no github repository configured`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  if (agent.github !== issue.repo) {
    const failed = makeFailedResult(
      base,
      "issue_ownership",
      "issue_not_owned_by_agent",
      `issue ${sourceRef} belongs to ${issue.repo}, but agent "${agentName}" is configured for ${agent.github}`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }
  checks.push(makePassedCheck("issue_ownership", "owned_by_agent", `issue belongs to ${agent.github}`));

  if (store.hasActiveTask(agentName)) {
    const failed = makeFailedResult(
      base,
      "agent_availability",
      "agent_busy",
      `agent "${agentName}" already has an active task`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  if (store.isAgentAuthDegraded(agentName)) {
    const failed = makeFailedResult(
      base,
      "agent_availability",
      "agent_auth_degraded",
      `agent "${agentName}" is auth-degraded and cannot receive implementation dispatches`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }
  checks.push(makePassedCheck("agent_availability", "agent_available", `agent "${agentName}" is available`));

  const dupCheck = checkDuplicate(store, "github", sourceRef);
  const bypassableDuplicate =
    allowDuplicateRecencyBypass &&
    dupCheck.isDuplicate &&
    dupCheck.existingTask !== undefined &&
    !["pending", "planning", "dispatched", "in_progress"].includes(dupCheck.existingTask.status);

  if (dupCheck.isDuplicate && !bypassableDuplicate) {
    const failed = makeFailedResult(
      base,
      "recent_failure_count",
      "duplicate_guard",
      dupCheck.reason ?? `duplicate dispatch blocked for ${sourceRef}`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  if (bypassableDuplicate) {
    checks.push(
      makeInfoCheck(
        "recent_failure_count",
        "duplicate_guard_bypassed",
        `bypassing recency window for ${sourceRef}: ${dupCheck.reason ?? "duplicate allowed"}`,
      ),
    );
  } else {
    checks.push(makePassedCheck("recent_failure_count", "no_duplicate_block", "no active or recent duplicate task"));
  }

  const failureLimit = config.escalation?.retry_limit ?? DEFAULT_ESCALATION_RETRY_LIMIT;
  const failureCount = store.countFailuresForSourceRef(sourceRef);
  if (failureLimit > 0 && failureCount >= failureLimit) {
    const failed = makeFailedResult(
      base,
      "recent_failure_count",
      "retry_limit_exceeded",
      `source_ref ${sourceRef} has ${failureCount} recorded failed attempt(s); retry limit is ${failureLimit}`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }
  checks.push(
    makePassedCheck(
      "recent_failure_count",
      "within_retry_budget",
      failureLimit > 0
        ? `${failureCount} failed attempt(s), below retry limit ${failureLimit}`
        : `${failureCount} failed attempt(s); retry-limit escalation disabled`,
    ),
  );

  const issueState = cachedGetIssueState(issue.repo, issue.number);
  if (issueState.state === "closed") {
    const failed = makeFailedResult(
      base,
      "issue_state",
      "issue_closed",
      `issue ${sourceRef} is already closed`,
    );
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }
  checks.push(makePassedCheck("issue_state", "issue_open", `issue ${sourceRef} is open`));

  let linkedPRs: LinkedPR[] = [];
  if (issueState.hasOpenPR || issueState.hasMergedPR) {
    linkedPRs = findExistingPRsForIssue(issue.repo, issue.number);
  }
  const mergedPR = linkedPRs.find((pr) => pr.state === "merged") ?? null;
  if (mergedPR) {
    const failed = makeFailedResult(
      base,
      "branch_conflicts",
      "merged_pr_exists",
      `issue ${sourceRef} is already addressed by merged PR #${mergedPR.number}`,
    );
    failed.blockingPRNumber = mergedPR.number;
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  const approvedPR = findApprovedPRForIssue(issue.repo, issue.number);
  if (approvedPR) {
    const failed = makeFailedResult(
      base,
      "branch_conflicts",
      "approved_pr_waiting",
      `issue ${sourceRef} already has approved PR #${approvedPR.number} awaiting merge`,
    );
    failed.blockingPRNumber = approvedPR.number;
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  const openPR = linkedPRs.find((pr) => pr.state === "open") ?? null;
  if (openPR && !openPR.isDraft) {
    const failed = makeFailedResult(
      base,
      "branch_conflicts",
      "open_pr_exists",
      `issue ${sourceRef} already has open PR #${openPR.number}`,
    );
    failed.blockingPRNumber = openPR.number;
    store.addDispatchValidation({
      source,
      source_ref: sourceRef,
      agent_name: agentName,
      repo: issue.repo,
      issue_number: issue.number,
      outcome: failed.outcome,
      failure_check: failed.failureCheck,
      failure_code: failed.failureCode,
      failure_reason: failed.failureReason,
      checklist: failed.checks,
    });
    return failed;
  }

  let draftPR: LinkedPR | null = null;
  if (openPR?.isDraft) {
    draftPR = openPR;
    checks.push(
      makeInfoCheck(
        "branch_conflicts",
        "draft_pr_resume",
        `issue ${sourceRef} has draft PR #${openPR.number}; resume work on the existing branch`,
      ),
    );
  } else {
    const existingBranch = findBranchForIssue(issue.repo, issue.number);
    base.existingBranch = existingBranch;
    if (existingBranch) {
      checks.push(
        makeInfoCheck(
          "branch_conflicts",
          "existing_branch_resume",
          `issue ${sourceRef} already has branch "${existingBranch}"; resume that branch`,
        ),
      );
    } else {
      checks.push(makePassedCheck("branch_conflicts", "no_branch_conflict", `no blocking PR or branch conflict for ${sourceRef}`));
    }
  }

  const passed: PreDispatchValidationResult = {
    ...base,
    outcome: "passed",
    failureCheck: null,
    failureCode: null,
    failureReason: null,
    blockingPRNumber: null,
    draftPR,
  };

  store.addDispatchValidation({
    source,
    source_ref: sourceRef,
    agent_name: agentName,
    repo: issue.repo,
    issue_number: issue.number,
    outcome: passed.outcome,
    checklist: passed.checks,
  });

  return passed;
}
