/**
 * Config Validator — validates agents.yaml values against type, range, and
 * constraint rules at load time and before hot-reload application.
 *
 * Returns a list of validation errors (empty = valid).  Callers decide
 * whether to abort (startup) or reject the reload (hot-reload).
 */

import type { OrchestratorConfig } from "./schema.js";

export interface ValidationError {
  /** Dot-path to the offending field (e.g. "proxy.timeout_ms"). */
  path: string;
  /** Human-readable description of the violation. */
  message: string;
}

// ── Individual validators ──────────────────────────────────────────────────

function requireString(obj: unknown, path: string, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val !== undefined && val !== null && typeof val !== "string") {
    errors.push({ path, message: `expected string, got ${typeof val}` });
  }
}

function requirePositiveNumber(obj: unknown, path: string, errors: ValidationError[], opts?: { required?: boolean }): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) {
    if (opts?.required) errors.push({ path, message: "required field is missing" });
    return;
  }
  if (typeof val !== "number" || !Number.isFinite(val)) {
    errors.push({ path, message: `expected a finite number, got ${JSON.stringify(val)}` });
    return;
  }
  if (val <= 0) {
    errors.push({ path, message: `must be positive (got ${val})` });
  }
}

function requireNonNegativeNumber(obj: unknown, path: string, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (typeof val !== "number" || !Number.isFinite(val)) {
    errors.push({ path, message: `expected a finite number, got ${JSON.stringify(val)}` });
    return;
  }
  if (val < 0) {
    errors.push({ path, message: `must be >= 0 (got ${val})` });
  }
}

function requireNumberInRange(obj: unknown, path: string, min: number, max: number, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (typeof val !== "number" || !Number.isFinite(val)) {
    errors.push({ path, message: `expected a finite number, got ${JSON.stringify(val)}` });
    return;
  }
  if (val < min || val > max) {
    errors.push({ path, message: `must be between ${min} and ${max} (got ${val})` });
  }
}

function requireBoolean(obj: unknown, path: string, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (typeof val !== "boolean") {
    errors.push({ path, message: `expected boolean, got ${typeof val}` });
  }
}

function requireNumberArray(obj: unknown, path: string, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (!Array.isArray(val)) {
    errors.push({ path, message: `expected array, got ${typeof val}` });
    return;
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== "number" || !Number.isFinite(val[i])) {
      errors.push({ path: `${path}[${i}]`, message: `expected number, got ${JSON.stringify(val[i])}` });
    }
  }
}

function requireStringArray(obj: unknown, path: string, errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (!Array.isArray(val)) {
    errors.push({ path, message: `expected array, got ${typeof val}` });
    return;
  }
  for (let i = 0; i < val.length; i++) {
    if (typeof val[i] !== "string") {
      errors.push({ path: `${path}[${i}]`, message: `expected string, got ${typeof val[i]}` });
    }
  }
}

function requireEnum(obj: unknown, path: string, allowed: string[], errors: ValidationError[]): void {
  const val = resolvePath(obj, path);
  if (val === undefined || val === null) return;
  if (typeof val !== "string" || !allowed.includes(val)) {
    errors.push({ path, message: `must be one of [${allowed.join(", ")}], got "${val}"` });
  }
}

// ── Path resolver ──────────────────────────────────────────────────────────

function resolvePath(obj: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ── Main validator ─────────────────────────────────────────────────────────

export function validateConfig(config: OrchestratorConfig): ValidationError[] {
  const errors: ValidationError[] = [];
  const raw = config as unknown;

  // ── Proxy ────────────────────────────────────────────────────────────────
  requireString(raw, "proxy.url", errors);
  requireString(raw, "proxy.manager_url", errors);
  requirePositiveNumber(raw, "proxy.timeout_ms", errors, { required: true });
  requireString(raw, "proxy.ssh_key", errors);

  // ── Verification ─────────────────────────────────────────────────────────
  if (config.verification) {
    requireBoolean(raw, "verification.enabled", errors);
    requireStringArray(raw, "verification.sources", errors);
    requireNumberInRange(raw, "verification.min_score", 0, 1, errors);
    requireNonNegativeNumber(raw, "verification.max_revisions", errors);
    requirePositiveNumber(raw, "verification.verify_per_cycle", errors);
    requireNumberInRange(raw, "verification.reviewer_low_score_threshold", 0, 1, errors);
  }

  // ── PR Review ────────────────────────────────────────────────────────────
  if (config.pr_review) {
    requirePositiveNumber(raw, "pr_review.feedback_ceiling", errors);
    requireNonNegativeNumber(raw, "pr_review.conflict_close_threshold", errors);
  }

  // ── Escalation ───────────────────────────────────────────────────────────
  if (config.escalation) {
    requireNonNegativeNumber(raw, "escalation.retry_limit", errors);
    requireString(raw, "escalation.notify_channel", errors);
  }

  // ── Retry ────────────────────────────────────────────────────────────────
  if (config.retry) {
    requireNonNegativeNumber(raw, "retry.max_connection_retries", errors);
    requireNumberArray(raw, "retry.connection_error_delays_ms", errors);
  }

  // ── LLM ──────────────────────────────────────────────────────────────────
  if (config.llm) {
    requireEnum(raw, "llm.provider", ["auto", "claude", "codex"], errors);
    requireString(raw, "llm.preferred_agent", errors);
    requireString(raw, "llm.default_model", errors);

    // Validate per-task provider overrides
    if (config.llm.task_providers) {
      for (const [task, provider] of Object.entries(config.llm.task_providers)) {
        requireEnum(raw, `llm.task_providers.${task}`, ["claude", "codex", "auto"], errors);
        if (provider === undefined) continue; // appease TS
      }
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────
  if (config.dashboard?.budget) {
    requireNumberInRange(raw, "dashboard.budget.warning_pct", 1, 100, errors);
    requireNumberInRange(raw, "dashboard.budget.critical_pct", 1, 200, errors);
  }
  if (config.dashboard?.digest) {
    requireString(raw, "dashboard.digest.slack_webhook", errors);
    // Validate schedule format HH:MM
    const schedule = config.dashboard.digest.schedule;
    if (schedule !== undefined && !/^\d{2}:\d{2}$/.test(schedule)) {
      errors.push({ path: "dashboard.digest.schedule", message: `must be in HH:MM format, got "${schedule}"` });
    }
  }

  // ── Providers ────────────────────────────────────────────────────────────
  if (config.providers) {
    for (const [name, provider] of Object.entries(config.providers)) {
      requireString(raw, `providers.${name}.model`, errors);
      if (provider.limits) {
        requirePositiveNumber(raw, `providers.${name}.limits.hourly`, errors);
        requirePositiveNumber(raw, `providers.${name}.limits.daily`, errors);
        requirePositiveNumber(raw, `providers.${name}.limits.weekly`, errors);
      }
    }
  }

  // ── Per-agent validation ─────────────────────────────────────────────────
  for (const [name, agent] of Object.entries(config.agents)) {
    const prefix = `agents.${name}`;

    requireString(raw, `${prefix}.dir`, errors);
    requireString(raw, `${prefix}.description`, errors);

    if (agent.max_concurrent !== undefined) {
      requirePositiveNumber(raw, `${prefix}.max_concurrent`, errors);
    }
    if (agent.stale_timeout_ms !== undefined) {
      requirePositiveNumber(raw, `${prefix}.stale_timeout_ms`, errors);
    }
    if (agent.auto_reroute_rejection_threshold !== undefined) {
      requireNonNegativeNumber(raw, `${prefix}.auto_reroute_rejection_threshold`, errors);
    }

    // Docker config
    if (agent.docker) {
      if (agent.docker.port !== undefined) {
        requirePositiveNumber(raw, `${prefix}.docker.port`, errors);
      }
      if (agent.docker.session !== undefined) {
        requireEnum(raw, `${prefix}.docker.session`, ["fresh", "continue", "resume"], errors);
      }
    }

    // Token budget
    if (agent.token_budget) {
      if (agent.token_budget.daily !== undefined) {
        requirePositiveNumber(raw, `${prefix}.token_budget.daily`, errors);
      }
      if (agent.token_budget.weekly !== undefined) {
        requirePositiveNumber(raw, `${prefix}.token_budget.weekly`, errors);
      }
      if (agent.token_budget.warning_pct !== undefined) {
        requireNumberInRange(raw, `${prefix}.token_budget.warning_pct`, 1, 100, errors);
      }
      if (agent.token_budget.critical_pct !== undefined) {
        requireNumberInRange(raw, `${prefix}.token_budget.critical_pct`, 1, 200, errors);
      }
      requireBoolean(raw, `${prefix}.token_budget.pause_on_exceeded`, errors);
    }
  }

  return errors;
}
