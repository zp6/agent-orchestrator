/**
 * OSS Engagement Validator — enforces Charter Article IV trust-commons principles.
 *
 * Binding constraints (from issue #1212):
 *   1. No unsolicited PR floods: max 1 PR per external project per quarter.
 *   2. Bug reports before patches: lead with reproducible reports, PRs only when invited.
 *   3. Earn standing one project at a time: sustained engagement before expanding.
 *   4. Radical transparency: every contribution signed with agent/fleet identity.
 *   5. Build, don't borrow: primary footprint is fleet-authored projects.
 *
 * This module provides:
 *   - Pre-dispatch validation for external repo engagement plans
 *   - Per-repo engagement state queries
 *   - Stigmergy signal helpers for `oss_engagement_proposal`
 */

import type { StateStore } from "../state/store.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("oss-engagement-validator");

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum PRs per external project per quarter. */
export const MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER = 1;

/** Days in a quarter for lookback window. */
const QUARTER_DAYS = 90;

/** Maximum number of external projects with active engagement at once. */
export const MAX_CONCURRENT_EXTERNAL_PROJECTS = 1;

// ── Types ────────────────────────────────────────────────────────────────────

export type EngagementType =
  | "bug_report"
  | "pr_submitted"
  | "pr_accepted"
  | "pr_rejected"
  | "issue_comment"
  | "discussion"
  | "maintainer_invitation";

export interface OSSEngagementRecord {
  id: number;
  /** External repo (e.g. "owner/repo"). */
  repo: string;
  /** Type of engagement. */
  engagement_type: EngagementType;
  /** Reference URL or identifier (e.g. PR URL, issue URL). */
  reference: string;
  /** Agent that performed the engagement. */
  agent: string;
  /** Optional notes or context. */
  notes: string | null;
  /** ISO timestamp. */
  created_at: string;
}

export interface EngagementProposal {
  /** External repo to engage with. */
  targetRepo: string;
  /** What kind of engagement is proposed. */
  engagementType: EngagementType;
  /** Agent proposing the engagement. */
  agent: string;
  /** Why this engagement is valuable. */
  rationale: string;
  /** Reference to related issue/PR if applicable. */
  reference?: string;
}

export interface EngagementValidationResult {
  allowed: boolean;
  reason: string;
  /** Which constraint blocked the engagement, if any. */
  constraintViolated: string | null;
  /** Summary of current engagement state for context. */
  engagementSummary: RepoEngagementSummary | null;
}

export interface RepoEngagementSummary {
  repo: string;
  totalContributions: number;
  prsThisQuarter: number;
  bugReportsThisQuarter: number;
  acceptances: number;
  rejections: number;
  lastEngagement: string | null;
  hasMaintainerInvitation: boolean;
}

// ── Engagement state queries ─────────────────────────────────────────────────

/**
 * Get a summary of engagement state for a specific external repo.
 */
export function getRepoEngagementSummary(
  store: StateStore,
  repo: string,
): RepoEngagementSummary {
  const quarterAgo = new Date(
    Date.now() - QUARTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const records = store.getOSSEngagementRecords(repo);
  const recentRecords = records.filter((r) => r.created_at >= quarterAgo);

  return {
    repo,
    totalContributions: records.length,
    prsThisQuarter: recentRecords.filter((r) => r.engagement_type === "pr_submitted").length,
    bugReportsThisQuarter: recentRecords.filter((r) => r.engagement_type === "bug_report").length,
    acceptances: records.filter((r) => r.engagement_type === "pr_accepted").length,
    rejections: records.filter((r) => r.engagement_type === "pr_rejected").length,
    lastEngagement: records.length > 0 ? records[0].created_at : null,
    hasMaintainerInvitation: records.some(
      (r) => r.engagement_type === "maintainer_invitation",
    ),
  };
}

/**
 * Get all repos with active external engagement (contributions in the last quarter).
 */
export function getActiveExternalProjects(store: StateStore): string[] {
  const quarterAgo = new Date(
    Date.now() - QUARTER_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const records = store.getRecentOSSEngagementRecords(quarterAgo);
  const repos = new Set(records.map((r) => r.repo));
  return [...repos];
}

// ── Core validation ──────────────────────────────────────────────────────────

/**
 * Validate a proposed external engagement against all binding constraints.
 *
 * Returns an EngagementValidationResult indicating whether the engagement
 * is allowed and why.
 */
export function validateEngagementProposal(
  store: StateStore,
  proposal: EngagementProposal,
): EngagementValidationResult {
  const summary = getRepoEngagementSummary(store, proposal.targetRepo);

  // ── Constraint 1: No unsolicited PR floods ──────────────────────────────
  if (proposal.engagementType === "pr_submitted") {
    if (summary.prsThisQuarter >= MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER) {
      log.warn("OSS engagement blocked: PR flood ceiling", {
        repo: proposal.targetRepo,
        prsThisQuarter: summary.prsThisQuarter,
        ceiling: MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER,
      });
      return {
        allowed: false,
        reason:
          `PR ceiling reached for ${proposal.targetRepo}: ${summary.prsThisQuarter} PR(s) ` +
          `submitted this quarter (max ${MAX_PRS_PER_EXTERNAL_REPO_PER_QUARTER}). ` +
          `Ceiling lifts only with demonstrated maintainer reception.`,
        constraintViolated: "no_unsolicited_pr_floods",
        engagementSummary: summary,
      };
    }
  }

  // ── Constraint 2: Bug reports before patches ────────────────────────────
  if (proposal.engagementType === "pr_submitted") {
    // Allow PRs if maintainer explicitly invited
    if (!summary.hasMaintainerInvitation) {
      // For a new repo with no prior bug reports, require bug report first
      if (summary.bugReportsThisQuarter === 0 && summary.totalContributions === 0) {
        log.warn("OSS engagement blocked: no bug report before PR", {
          repo: proposal.targetRepo,
        });
        return {
          allowed: false,
          reason:
            `No prior engagement with ${proposal.targetRepo}. ` +
            `Lead with a reproducible bug report and diagnosis first. ` +
            `PRs only when invited or after establishing rapport via bug reports.`,
          constraintViolated: "bug_reports_before_patches",
          engagementSummary: summary,
        };
      }
    }
  }

  // ── Constraint 3: Earn standing one project at a time ───────────────────
  const activeProjects = getActiveExternalProjects(store);
  const isNewProject = !activeProjects.includes(proposal.targetRepo);

  if (isNewProject && activeProjects.length >= MAX_CONCURRENT_EXTERNAL_PROJECTS) {
    // Check if existing projects have demonstrated sustained engagement
    // (at least one acceptance or multiple interactions)
    const existingHasStanding = activeProjects.some((repo) => {
      const s = getRepoEngagementSummary(store, repo);
      return s.acceptances > 0 || s.totalContributions >= 3;
    });

    if (!existingHasStanding) {
      log.warn("OSS engagement blocked: earn standing first", {
        activeProjects,
        newRepo: proposal.targetRepo,
      });
      return {
        allowed: false,
        reason:
          `Cannot expand to ${proposal.targetRepo} while actively engaged with ` +
          `${activeProjects.join(", ")}. Earn sustained standing (acceptance or ` +
          `3+ interactions) on current project(s) before expanding.`,
        constraintViolated: "earn_standing_one_at_a_time",
        engagementSummary: summary,
      };
    }
  }

  // ── Constraint 4: Radical transparency ──────────────────────────────────
  // This is enforced at the content level (signatures on contributions),
  // not at the validation gate. We add an info-level reminder.
  // Actual enforcement happens in the dispatch instructions.

  // ── Constraint 5: Build, don't borrow ───────────────────────────────────
  // This is a strategic principle, not a gate. External contributions should
  // be secondary to fleet-authored OSS projects. Validated at planning time
  // by the supervisor, not at dispatch time.

  log.info("OSS engagement proposal validated — allowed", {
    repo: proposal.targetRepo,
    type: proposal.engagementType,
    agent: proposal.agent,
  });

  return {
    allowed: true,
    reason: `Engagement with ${proposal.targetRepo} is within all constraints.`,
    constraintViolated: null,
    engagementSummary: summary,
  };
}

// ── Stigmergy signal helpers ─────────────────────────────────────────────────

/**
 * Write an `oss_engagement_proposal` signal for fleet-wide visibility.
 *
 * Other agents and the supervisor can read these signals to track and
 * review external engagement across the fleet.
 */
export function writeEngagementProposalSignal(
  store: StateStore,
  proposal: EngagementProposal,
  validationResult: EngagementValidationResult,
): void {
  const key = `oss-engagement-${proposal.targetRepo}-${proposal.engagementType}-${Date.now()}`;
  try {
    store.writeSignal({
      agent: proposal.agent,
      signal_type: "oss_engagement_proposal",
      key,
      value: {
        targetRepo: proposal.targetRepo,
        engagementType: proposal.engagementType,
        rationale: proposal.rationale,
        reference: proposal.reference ?? null,
        allowed: validationResult.allowed,
        reason: validationResult.reason,
        constraintViolated: validationResult.constraintViolated,
        engagementSummary: validationResult.engagementSummary,
      },
      repo: proposal.targetRepo,
      confidence: validationResult.allowed ? 0.9 : 0.95,
      ttl_hours: 336, // 14 days
    });
    log.info("OSS engagement proposal signal written", {
      key,
      allowed: validationResult.allowed,
    });
  } catch (err) {
    log.warn("Failed to write OSS engagement proposal signal", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record an OSS engagement event (contribution, acceptance, rejection, etc.).
 */
export function recordEngagement(
  store: StateStore,
  params: {
    repo: string;
    engagementType: EngagementType;
    reference: string;
    agent: string;
    notes?: string;
  },
): void {
  store.addOSSEngagementRecord({
    repo: params.repo,
    engagement_type: params.engagementType,
    reference: params.reference,
    agent: params.agent,
    notes: params.notes ?? null,
  });

  log.info("OSS engagement recorded", {
    repo: params.repo,
    type: params.engagementType,
    agent: params.agent,
  });
}

// ── Pre-dispatch integration ─────────────────────────────────────────────────

/**
 * Determine whether a dispatch target repo is external (not a fleet-owned repo).
 *
 * A repo is "external" if it does not appear in the agents config as any
 * agent's `github` repo.
 */
export function isExternalRepo(
  agentRepos: string[],
  targetRepo: string,
): boolean {
  return !agentRepos.includes(targetRepo);
}

/**
 * Build the transparency signature that must accompany any external contribution.
 *
 * Constraint 4 (Radical transparency): every external contribution must be
 * signed with agent bot identity, fleet identity, and operator escalation path.
 */
export function buildTransparencySignature(agentName: string): string {
  return [
    `This contribution was authored by \`${agentName}\`, an autonomous AI agent`,
    `in the Claude Agent Orchestrator fleet.`,
    ``,
    `- **Agent**: ${agentName}`,
    `- **Fleet**: Claude Agent Orchestrator (rapartlu/agent-orchestrator)`,
    `- **Nature**: Autonomous AI-generated contribution`,
    `- **Operator escalation**: via fleet GitHub issues`,
  ].join("\n");
}
