/**
 * Antibody seeding (issue #1392).
 *
 * Seeds the `signals` table with initial failure-prevention antibodies based on
 * the fleet's top recurring failure classes.  These seeds bootstrap the adaptive
 * immune system before auto-harvest (Phase 2) is built.
 *
 * Each antibody is a signal with:
 * - signal_type: one of the ANTIBODY_SIGNAL_TYPES from dispatch-antibodies.ts
 * - key: a human-readable error signature
 * - value: JSON with { fix_hint, error_class, source_issue }
 * - confidence: initial confidence (0.7 for manually seeded)
 * - ttl_hours: 720 (30 days) for seeds — long enough to validate
 *
 * Seeding is idempotent: existing signals with the same (signal_type, key) are
 * skipped to avoid duplicates.
 */

import { StateStore } from "../state/store.js";

const SEED_AGENT = "orchestrator-antibody-seeder";
const SEED_TTL_HOURS = 720; // 30 days
const SEED_CONFIDENCE = 0.7;

interface AntibodySeed {
  signal_type: string;
  key: string;
  value: {
    fix_hint: string;
    error_class: string;
    source_issue?: string;
    source_pr?: string;
  };
  repo?: string;
}

/**
 * Initial antibody seeds derived from the fleet's top failure classes
 * as of 2026-05-01 (20.2% failure rate, 195 failures/week).
 */
export const INITIAL_ANTIBODY_SEEDS: AntibodySeed[] = [
  // Connection error class — the #1 failure mode (#1347, proxy #517)
  {
    signal_type: "connection_error_fix",
    key: "ECONNRESET-idle-session",
    value: {
      fix_hint:
        "Connection resets on idle sessions are common. If you encounter ECONNRESET or " +
        "connection timeout errors, retry the operation up to 3 times with exponential " +
        "backoff (1s, 2s, 4s). Use keepAlive: true on HTTP agents. Do not treat a single " +
        "connection error as a fatal failure.",
      error_class: "connection-error-exhausted",
      source_issue: "rapartlu/agent-orchestrator#1347",
    },
  },
  {
    signal_type: "connection_error_fix",
    key: "gh-cli-connection-timeout",
    value: {
      fix_hint:
        "GitHub CLI operations (gh pr create, gh issue comment) sometimes fail with " +
        "connection errors. Always wrap gh CLI calls in a retry loop: " +
        "retry 3 times with 5-second delays. Check `gh auth status` before starting " +
        "work to catch auth issues early.",
      error_class: "connection-error-exhausted",
      source_issue: "rapartlu/agent-proxy#517",
    },
  },
  // Duplicate dispatch prevention
  {
    signal_type: "duplicate_dispatch_prevention",
    key: "check-existing-prs-before-work",
    value: {
      fix_hint:
        "Before starting any implementation, run `gh pr list --repo <repo> --state open " +
        "--search '<issue-number>'` to check if a PR already exists for this issue. " +
        "If an open PR exists, do NOT create a new one — instead review and push to " +
        "the existing PR branch. Creating duplicate PRs wastes dispatch capacity.",
      error_class: "already-in-review",
      source_issue: "rapartlu/agent-reviewer#617",
    },
  },
  // Git branch conflicts
  {
    signal_type: "failure_antibody",
    key: "branch-already-exists",
    value: {
      fix_hint:
        "Before creating a branch, check if it already exists: " +
        "`git branch -a | grep issue-<N>`. If the branch exists, check it out " +
        "and continue work there rather than creating a new branch with a different name. " +
        "Orphan branches waste capacity and cause merge conflicts.",
      error_class: "branch-collision",
      source_issue: "rapartlu/agent-orchestrator#1358",
    },
  },
  // Build/test failures
  {
    signal_type: "failure_antibody",
    key: "run-build-before-commit",
    value: {
      fix_hint:
        "Always run `npm run build` before committing TypeScript changes. " +
        "Type errors caught at build time prevent failed verification rounds. " +
        "If the project has tests, run `npm test` as well. Do not push code that " +
        "does not compile.",
      error_class: "build-failure",
    },
  },
  // PR creation failures
  {
    signal_type: "failure_antibody",
    key: "pr-create-auth-check",
    value: {
      fix_hint:
        "Before running `gh pr create`, verify auth with `gh auth status`. " +
        "If auth fails, do NOT proceed with the push — surface the error immediately. " +
        "A pushed branch without a PR is an orphan that blocks future dispatches.",
      error_class: "gh-auth-failure",
      source_issue: "rapartlu/agent-orchestrator#1358",
    },
  },
];

/**
 * Seed initial antibodies into the signals table.
 *
 * Idempotent: checks for existing signals with the same (signal_type, key) before
 * inserting.  Returns the count of newly inserted seeds.
 */
export function seedAntibodies(store: StateStore): { seeded: number; skipped: number } {
  let seeded = 0;
  let skipped = 0;

  for (const seed of INITIAL_ANTIBODY_SEEDS) {
    // Check for existing signal with same type and key
    const existing = store.readSignals({
      signal_type: seed.signal_type,
      limit: 500,
    });

    const alreadyExists = existing.some(
      (s) => s.signal_type === seed.signal_type && s.key === seed.key,
    );

    if (alreadyExists) {
      skipped++;
      continue;
    }

    store.writeSignal({
      agent: SEED_AGENT,
      signal_type: seed.signal_type,
      key: seed.key,
      value: seed.value,
      repo: seed.repo,
      confidence: SEED_CONFIDENCE,
      ttl_hours: SEED_TTL_HOURS,
    });
    seeded++;
  }

  return { seeded, skipped };
}
