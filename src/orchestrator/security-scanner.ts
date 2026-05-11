/**
 * Proactive Security Scanner (issue #544)
 *
 * Runs daily against every agent repo with a `github` field.  Detects:
 *   1. Plaintext `.env` files committed to git (not just a sample/template)
 *   2. Unencrypted secret-like patterns in committed files
 *   3. Docker Compose `env_file:` directives pointing at a live `.env` file
 *
 * When findings are discovered the scanner:
 *   - Creates a [Security] GitHub issue in the affected repo (deduplicated to
 *     avoid spam — one issue per unique finding per repo)
 *   - Sends a Telegram alert at "warning" urgency
 *
 * The daemon calls `maybeRunDailySecurityScan()` every poll cycle; it fires at
 * most once per calendar day (same "last date" pattern as the Slack digest).
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";
import { notifyOperator } from "../service/notify.js";
import { createLogger } from "../service/logger.js";

const log = createLogger("security-scanner");

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SecurityFinding {
  /** "owner/repo" */
  repo: string;
  /** Path within the repository, e.g. ".env" or "services/api/.env" */
  filePath: string;
  /** 1-based line number of the matching line, if known */
  lineNumber?: number;
  /** Human-readable pattern name, e.g. "plaintext .env file" */
  patternName: string;
  /** One-sentence description of the problem */
  description: string;
  severity: "high" | "medium";
}

export interface SecurityScanState {
  /** "YYYY-MM-DD" of the last scan run (local time). null = never run. */
  lastScanDate: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/** File names / patterns that are safe to ignore (samples, docs, fixtures). */
const ENV_SAFE_SUFFIXES = [
  ".example",
  ".sample",
  ".template",
  ".test",
  ".ci",
  ".dist",
  ".local.example",
];

/**
 * Regex patterns for secret-like values in key=value lines.
 * Step 1: capture the full key name and its value.
 * Step 2 (see scanContentForSecrets): check whether the key ends with a
 *   sensitive suffix using SENSITIVE_KEY_SUFFIXES.
 *
 * We use a two-step approach so that the greedy wildcard `[A-Z0-9_]*` in
 * the key portion doesn't accidentally consume the suffix we're looking for.
 */
const KEY_VALUE_PATTERN =
  /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.+)$/gim;

/** Key name suffixes (or full names) that suggest a credential value. */
const SENSITIVE_KEY_SUFFIXES = [
  "API_KEY",
  "API_SECRET",
  "ACCESS_TOKEN",
  "AUTH_TOKEN",
  "SECRET_KEY",
  "SECRET_TOKEN",
  "PRIVATE_KEY",
  "PASSWORD",
  "PASSWD",
  "_TOKEN",
  "_SECRET",
  "_KEY",
];

/**
 * Substrings that, if found anywhere in a value, indicate it's a placeholder.
 * Must be long enough to avoid false-positive matches against real tokens.
 */
const PLACEHOLDER_SUBSTRINGS = [
  "your_",
  "your-",
  "changeme",
  "replace_me",
  "replace-me",
  "placeholder",
  "example",
  "xxxx",
];

/**
 * Values that indicate a placeholder when the ENTIRE value matches (exact).
 * Short strings like "true", "false", "none", "0", "1" would false-positive
 * against real secrets if used as substring checks.
 */
const PLACEHOLDER_EXACT = new Set([
  "true",
  "false",
  "none",
  "null",
  "0",
  "1",
  "",
]);

/**
 * Pattern to extract file paths from Docker Compose `env_file:` blocks.
 * Handles both inline (`env_file: .env`) and list form:
 *   env_file:
 *     - .env
 *     - secrets.env
 *
 * The pattern captures each non-whitespace file path value after a colon
 * or a list dash.  We then check each captured path against isLiveEnvFile().
 */
const DOCKER_ENV_FILE_BLOCK =
  /env_file\s*:((?:\s*-?\s*["']?[^\s"'#\r\n]+["']?)+)/gi;
const DOCKER_ENV_FILE_PATH = /["']?([^\s"'#\r\n]+)["']?/g;

// ─────────────────────────────────────────────────────────────────────────────
// Core scanner
// ─────────────────────────────────────────────────────────────────────────────

/**
 * List all files in the default branch of a GitHub repo, returning their
 * paths.  Uses `gh api` to avoid local clone requirements.
 * Returns an empty array on any error (fail-open — skip, don't crash).
 */
export function listRepoFiles(repo: string): string[] {
  try {
    const raw = execSync(
      `gh api repos/${repo}/git/trees/HEAD?recursive=1 --jq '.tree[].path'`,
      { encoding: "utf-8", timeout: 20_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!raw) return [];
    return raw.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Fetch the raw text content of a file from GitHub via `gh api`.
 * Returns null on any error (404, binary files, etc.).
 */
export function fetchFileContent(repo: string, path: string): string | null {
  try {
    const raw = execSync(
      `gh api repos/${repo}/contents/${encodeURIComponent(path)} --jq '.content' | base64 -d`,
      { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Return true if this .env filename looks like a real secrets file (not a
 * sample/template that's intentionally committed).
 */
export function isLiveEnvFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  if (!lower.includes(".env")) return false;
  // Allow: .env.example, .env.sample, .env.template, .env.test, .env.ci …
  for (const suffix of ENV_SAFE_SUFFIXES) {
    if (lower.endsWith(suffix) || lower.includes(suffix + ".")) return false;
  }
  return true;
}

/**
 * Return true if `value` looks like an actual secret (not a placeholder).
 */
export function looksLikeRealSecret(value: string): boolean {
  const v = value.trim();
  if (v.length < 6) return false;
  const lower = v.toLowerCase();

  // Exact-match check (short/boolean values that are never real secrets)
  if (PLACEHOLDER_EXACT.has(lower)) return false;

  // Reject values that contain angle-bracket placeholders
  if (lower.includes("<") || lower.includes(">")) return false;

  // Substring check for known placeholder patterns
  for (const ph of PLACEHOLDER_SUBSTRINGS) {
    if (lower.includes(ph)) return false;
  }

  // Reject pure-environment-variable references like $MY_TOKEN or ${MY_TOKEN}
  if (/^\$\{?[A-Z_]+\}?$/.test(v)) return false;

  return true;
}

/**
 * Scan the text content of a file for secret-like key=value assignments.
 * Uses a two-step approach:
 *   1. Match every KEY=VALUE line (KEY_VALUE_PATTERN).
 *   2. Check whether the key ends with a sensitive suffix.
 *   3. Check whether the value looks like a real secret (not a placeholder).
 * Returns a list of findings (one per matching line).
 */
export function scanContentForSecrets(
  content: string,
  repo: string,
  filePath: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (/^\s*#/.test(line)) continue;

    // Reset and apply the pattern line-by-line
    KEY_VALUE_PATTERN.lastIndex = 0;
    const match = KEY_VALUE_PATTERN.exec(line);
    if (!match) continue;

    const keyName = match[1];
    const value = match[2].trim();

    // Check if the key ends with a sensitive suffix (case-insensitive)
    const upperKey = keyName.toUpperCase();
    const isSensitive = SENSITIVE_KEY_SUFFIXES.some((s) =>
      upperKey.endsWith(s) || upperKey === s.replace(/^_/, ""),
    );
    if (!isSensitive) continue;

    if (!looksLikeRealSecret(value)) continue;

    const maskedValue = value.slice(0, 4) + "***";

    findings.push({
      repo,
      filePath,
      lineNumber: i + 1,
      patternName: "plaintext secret in committed file",
      description:
        `\`${keyName}\` appears to contain a real credential value (\`${maskedValue}\`) committed to git`,
      severity: "high",
    });
  }

  return findings;
}

/**
 * Scan a Docker Compose file for `env_file:` directives pointing at live
 * `.env` files (not templates/examples).
 *
 * Two-step parsing:
 *   1. DOCKER_ENV_FILE_BLOCK captures everything after `env_file:` up to the
 *      next non-list line.
 *   2. DOCKER_ENV_FILE_PATH then extracts individual file paths from that block.
 */
export function scanDockerComposeForEnvFiles(
  content: string,
  repo: string,
  filePath: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];

  DOCKER_ENV_FILE_BLOCK.lastIndex = 0;
  let blockMatch: RegExpExecArray | null;

  while ((blockMatch = DOCKER_ENV_FILE_BLOCK.exec(content)) !== null) {
    const block = blockMatch[1];

    DOCKER_ENV_FILE_PATH.lastIndex = 0;
    let pathMatch: RegExpExecArray | null;

    while ((pathMatch = DOCKER_ENV_FILE_PATH.exec(block)) !== null) {
      const envFilePath = pathMatch[1].trim();
      // Skip bare dashes (list markers consumed by the outer pattern)
      if (envFilePath === "-") continue;
      if (!isLiveEnvFile(envFilePath)) continue;

      findings.push({
        repo,
        filePath,
        patternName: "Docker Compose env_file referencing plaintext .env",
        description:
          `Docker Compose service mounts \`${envFilePath}\` via \`env_file\` — ` +
          `if this file contains real secrets it should be encrypted or use Docker secrets instead`,
        severity: "medium",
      });
    }
  }

  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// YAML local-config scanner (issue #756 — follow-up from agent-proxy#390)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * YAML key names (case-insensitive) that may hold plaintext credentials in
 * agents.yaml or other local YAML config files.
 */
const YAML_SENSITIVE_KEYS = [
  "api_key",
  "api_secret",
  "access_token",
  "auth_token",
  "secret_key",
  "secret_token",
  "private_key",
  "password",
  "passwd",
  "token",
  "secret",
  "credential",
];

/**
 * Per-line regex that matches YAML scalar assignments of the form:
 *   api_key: "value"
 *   api_key: 'value'
 *   api_key: value
 *
 * Group 1 = key name.
 * Group 2 = double-quoted value (without surrounding quotes).
 * Group 3 = single-quoted value (without surrounding quotes).
 * Group 4 = unquoted value (trimmed; stripped of inline comments).
 *
 * Note: this is intentionally applied line-by-line (not with `gm` flags) to
 * avoid module-level regex state contamination between invocations.
 */
const YAML_LINE_PATTERN =
  /^\s*([\w-]+)\s*:\s*(?:"([^"]*)"|'([^']*)'|((?:[^#"'\s][^\n]*?)?))(?:\s*#.*)?$/;

/**
 * Scan YAML-formatted content (e.g. agents.yaml) for plaintext secrets in
 * key: value pairs.  This complements `scanContentForSecrets` which targets
 * shell-style KEY=VALUE files.
 *
 * Returns one SecurityFinding per detected line.
 */
export function scanYamlContentForSecrets(
  content: string,
  label: string,
  filePath: string,
): SecurityFinding[] {
  const findings: SecurityFinding[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and empty lines
    if (/^\s*#/.test(line) || /^\s*$/.test(line)) continue;

    const match = YAML_LINE_PATTERN.exec(line);
    if (!match) continue;

    const keyName = match[1];
    // Value is whichever capture group matched; prefer quoted groups
    const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
    const value = rawValue.trim();

    const lowerKey = keyName.toLowerCase();
    const isSensitive = YAML_SENSITIVE_KEYS.some(
      (s) =>
        lowerKey === s ||
        lowerKey.endsWith(`_${s}`) ||
        lowerKey.startsWith(`${s}_`),
    );
    if (!isSensitive) continue;
    if (!looksLikeRealSecret(value)) continue;

    const maskedValue = value.slice(0, 4) + "***";

    findings.push({
      repo: label,
      filePath,
      lineNumber: i + 1,
      patternName: "plaintext secret in YAML config",
      description:
        `\`${keyName}\` appears to contain a real credential value (\`${maskedValue}\`) in \`${filePath}\` — ` +
        `use an environment variable reference (e.g. \`\${MY_VAR}\`) or a secrets manager instead`,
      severity: "high",
    });
  }

  return findings;
}

/**
 * Read a local file and scan it for YAML-format plaintext secrets.
 * Returns an empty array if the file cannot be read (fail-open).
 */
export function scanLocalYamlFile(
  filePath: string,
  label: string,
): SecurityFinding[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    log.warn("Security scan: could not read local config file", { filePath });
    return [];
  }
  return scanYamlContentForSecrets(content, label, filePath);
}

/**
 * Run a full security scan of one repository.
 * Returns all findings (may be empty).
 */
export function scanRepo(repo: string): SecurityFinding[] {
  log.info("Security scan: scanning repo", { repo });
  const findings: SecurityFinding[] = [];

  let files: string[];
  try {
    files = listRepoFiles(repo);
  } catch {
    log.warn("Security scan: failed to list files", { repo });
    return [];
  }

  if (files.length === 0) {
    log.info("Security scan: repo has no files (or gh api error)", { repo });
    return [];
  }

  for (const filePath of files) {
    const lower = filePath.toLowerCase();
    const isEnvFile =
      /(?:^|\/)\.env(\.[^/]*)?$/.test(lower) || lower.endsWith(".env");
    const isDockerCompose = /(?:^|\/)docker-compose[^/]*\.ya?ml$/.test(lower);

    if (!isEnvFile && !isDockerCompose) continue;

    if (isEnvFile && !isLiveEnvFile(filePath)) continue;

    // Fetch file content
    const content = fetchFileContent(repo, filePath);
    if (!content) continue;

    if (isEnvFile) {
      // Flag the file itself as a plaintext .env
      findings.push({
        repo,
        filePath,
        patternName: "plaintext .env file committed to git",
        description:
          `\`${filePath}\` is a plaintext environment file tracked by git. ` +
          `It may contain secrets that should never be committed.`,
        severity: "high",
      });
      // Also scan its contents for actual secret values
      findings.push(...scanContentForSecrets(content, repo, filePath));
    }

    if (isDockerCompose) {
      findings.push(...scanDockerComposeForEnvFiles(content, repo, filePath));
    }
  }

  log.info("Security scan: scan complete", { repo, findingCount: findings.length });
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue creation & deduplication
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return true if an open [Security] issue with a matching file path already
 * exists in the repo (prevents re-creating issues on every daily scan).
 */
export function securityIssueExists(repo: string, filePath: string): boolean {
  try {
    const raw = execSync(
      `gh issue list --repo ${repo} --state open --label security --json title -L 200`,
      { encoding: "utf-8", timeout: 15_000, stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
    if (!raw) return false;
    const issues = JSON.parse(raw) as { title: string }[];
    return issues.some((i) => i.title.includes(filePath));
  } catch {
    return false; // fail-open
  }
}

/**
 * Create a GitHub issue for a group of findings that share the same file.
 * Uses the `security` label so issues are easily filterable.
 */
export function createSecurityIssue(
  repo: string,
  findings: SecurityFinding[],
): void {
  if (findings.length === 0) return;

  const firstFinding = findings[0];
  const title = `[Security] Plaintext secret detected: ${firstFinding.filePath}`;

  const bodyLines: string[] = [
    "## 🔐 Security Finding",
    "",
    `**Repository:** \`${repo}\``,
    `**File:** \`${firstFinding.filePath}\``,
    "",
    "### Findings",
    "",
  ];

  for (const finding of findings) {
    const lineRef = finding.lineNumber ? ` (line ${finding.lineNumber})` : "";
    bodyLines.push(
      `- **${finding.patternName}**${lineRef}: ${finding.description}`,
    );
  }

  bodyLines.push(
    "",
    "### Recommended Actions",
    "",
    "1. Remove the file from git history: `git filter-repo --invert-paths --path <file>`",
    "2. Rotate any exposed credentials immediately",
    "3. Add the file to `.gitignore` if it contains runtime secrets",
    "4. Use Docker secrets, environment injection, or a secrets manager instead",
    "",
    "---",
    "*This issue was automatically created by the orchestrator security scanner.*",
  );

  try {
    execSync(
      `gh issue create --repo ${repo} ` +
        `--title ${shellEscape(title)} ` +
        `--body ${shellEscape(bodyLines.join("\n"))} ` +
        `--label security`,
      { encoding: "utf-8", timeout: 30_000 },
    );
    log.info("Security scan: created issue", { repo, file: firstFinding.filePath });
  } catch (err) {
    log.error("Security scan: failed to create issue", {
      repo,
      file: firstFinding.filePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan all agent repos and create issues / send alerts for any findings.
 * Also scans the orchestrator's own local config file (agents.yaml) for
 * YAML-format plaintext secrets (follow-up from agent-proxy#390, issue #756).
 * Groups findings by file to avoid one issue per finding line.
 */
export async function runSecurityScan(
  config: OrchestratorConfig,
  configPath?: string,
  store?: StateStore,
): Promise<void> {
  const repos = new Set<string>();
  for (const agent of Object.values(config.agents)) {
    if (agent.github) repos.add(agent.github);
  }

  log.info("Security scan: starting daily scan", { repoCount: repos.size });

  // ── 1. Scan the orchestrator's own local config file ──────────────────────
  // Local findings are not tracked as GitHub issues (the file is not in a
  // remote repo) — we log a warning and send a Telegram alert instead.
  const localConfigPath =
    configPath ?? (config.orchestrator_dir
      ? `${config.orchestrator_dir}/agents.yaml`
      : undefined);

  if (localConfigPath) {
    const localFindings = scanLocalYamlFile(localConfigPath, "local-config");
    if (localFindings.length > 0) {
      log.warn("Security scan: plaintext secrets found in local config", {
        filePath: localConfigPath,
        count: localFindings.length,
      });
      const summary = localFindings
        .map(
          (f) =>
            `\`${f.filePath}\` line ${f.lineNumber ?? "?"}: ${f.patternName}`,
        )
        .join("\n");
      await notifyOperator(
        `Security scan: plaintext secrets in local config`,
        `Found ${localFindings.length} plaintext secret(s) in \`${localConfigPath}\`:\n\n${summary}\n\nReplace hardcoded values with environment variable references.`,
        "warning",
        "security-scan-local-config",
      );
    }
  }

  // ── 2. Scan each agent's GitHub repo ─────────────────────────────────────
  const allFindings: SecurityFinding[] = [];
  for (const repo of repos) {
    const findings = scanRepo(repo);
    allFindings.push(...findings);
  }

  if (allFindings.length === 0) {
    log.info("Security scan: no findings");
    return;
  }

  // Group findings by (repo, filePath)
  const grouped = new Map<string, SecurityFinding[]>();
  for (const finding of allFindings) {
    const key = `${finding.repo}::${finding.filePath}`;
    const group = grouped.get(key) ?? [];
    group.push(finding);
    grouped.set(key, group);
  }

  let issuesCreated = 0;
  for (const [_key, group] of grouped) {
    const { repo, filePath, patternName } = group[0];
    // Check the FP exemption registry before creating an issue.  When the
    // finding matches a confirmed false-positive triple, skip it permanently.
    if (store && store.isSecurityFpExempt(repo, filePath, patternName)) {
      log.info("Security scan: finding exempted, skipping", { repo, filePath, patternName });
      continue;
    }
    if (securityIssueExists(repo, filePath)) {
      log.info("Security scan: issue already exists, skipping", { repo, filePath });
      continue;
    }
    createSecurityIssue(repo, group);
    issuesCreated++;
  }

  if (issuesCreated > 0) {
    const summary = allFindings
      .slice(0, 5)
      .map((f) => `${f.repo} — \`${f.filePath}\` (${f.patternName})`)
      .join("\n");
    const moreNote =
      allFindings.length > 5 ? `\n…and ${allFindings.length - 5} more finding(s)` : "";

    await notifyOperator(
      `Security scan: ${issuesCreated} new finding(s)`,
      `Plaintext secrets detected in ${issuesCreated} file(s):\n\n${summary}${moreNote}\n\nIssues created. Rotate any exposed credentials immediately.`,
      "warning",
      "security-scan-findings",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Daily scheduler (same pattern as the Slack digest)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Return today's date as "YYYY-MM-DD" in local time.
 */
export function todayDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Called every daemon poll cycle.  Fires the security scan at most once per
 * calendar day (around 02:00 local time to avoid peak hours).
 */
export async function maybeRunDailySecurityScan(
  state: SecurityScanState,
  config: OrchestratorConfig,
  now: Date = new Date(),
  store?: StateStore,
): Promise<void> {
  const today = todayDateString(now);

  // Already ran today — skip
  if (state.lastScanDate === today) return;

  // Fire only after 02:00 local time so the scan runs in the low-traffic window
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  if (currentMinutes < 2 * 60) return;

  state.lastScanDate = today;
  log.info("Security scan: firing daily scan", { date: today });

  try {
    await runSecurityScan(config, undefined, store);
  } catch (err) {
    log.error("Security scan: unexpected error during daily scan", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
