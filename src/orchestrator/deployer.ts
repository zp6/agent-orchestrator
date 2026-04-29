import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ManagementClient, type ProxyAgentConfig } from "../client/management-client.js";
import { AgentClient } from "../client/agent-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentBaseUrl } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const REPO_SHA_DIR = resolve(homedir(), ".claude-orchestrator", "repo-deploy-shas");

export interface DeployResult {
  agentName: string;
  action: "redeployed" | "up-to-date" | "error" | "health-check-failed";
  detail?: string;
}

/**
 * Three distinct mount states for a secret file.
 *
 * - `present-and-valid`: file exists on disk and contains non-empty content.
 * - `mounted-but-empty`: file path is reachable (no ENOENT) but the content is
 *   empty — typically a misconfigured host-side bind mount or a race during
 *   container startup where the secrets injector hasn't written the value yet.
 * - `not-mounted`: the path does not exist (ENOENT) or the agent could not
 *   read it at all — the secret was never injected.
 *
 * The distinction matters for the pre-dispatch validator: `not-mounted` is a
 * hard block (the agent cannot authenticate), while `mounted-but-empty` is a
 * soft warning (the agent may succeed if the injector writes the value before
 * the task starts).
 */
export type SecretMountStatus = "present-and-valid" | "mounted-but-empty" | "not-mounted";

/** Per-secret mount state returned by checkSecretsHealth(). */
export interface SecretMountDetail {
  /** Secret name as reported by the agent (e.g. "oauth_token", "gh_token"). */
  name: string;
  /** Classified mount state. */
  status: SecretMountStatus;
  /** Human-readable reason string for dashboards and incident reports. */
  reason: string;
}

/** Result of probing an agent's /secrets/health endpoint. */
export interface SecretsHealthResult {
  /** True if the HTTP call succeeded (false means agent was unreachable). */
  reachable: boolean;
  /** True when all required secrets are present-and-valid. */
  healthy: boolean;
  /** Names of required secrets that are missing or unreadable (legacy field). */
  unhealthySecrets: string[];
  /**
   * Per-secret mount details with three-state classification.
   * Empty when reachable=false or the agent does not return a `secrets` array.
   */
  mountDetails: SecretMountDetail[];
  /** Error description when reachable=false or the call threw. */
  error?: string;
}

/**
 * Default delays (ms) between health-check attempts.
 * Extended from [2s, 5s, 15s, 30s] (52s) to [3s, 10s, 20s, 30s, 45s, 60s]
 * to accommodate the Claude Code CLI's startup sequence, which uses an
 * exponential-backoff readiness probe on first start / after a restart that
 * can take up to ~120s. The previous 52s window expired before the container
 * was ready (codex-proxy incident 2026-04-12, issue #728).
 *
 * Total window: 3 + 10 + 20 + 30 + 45 + 60 = 168s (covers ~120s CLI init).
 *
 * Override per-agent in agents.yaml via `docker.health_check_delays_ms`, or
 * globally via `deploy.health_check_delays_ms`.
 */
const HEALTH_CHECK_DELAYS_MS = [3_000, 10_000, 20_000, 30_000, 45_000, 60_000];

/**
 * Default post-restart warmup delay (ms). After a container passes the health
 * check, wait this long before returning — gives the entrypoint time to finish
 * git pull, CLI init, and temp-file setup before the daemon dispatches work.
 * Configurable via `deploy.post_restart_warmup_ms` in agents.yaml.
 */
export const POST_RESTART_WARMUP_MS = 5_000;

export class Deployer {
  private management: ManagementClient;
  private agentClient: AgentClient;
  private log = createLogger("deployer");

  constructor(private config: OrchestratorConfig) {
    this.management = new ManagementClient(config.proxy);
    this.agentClient = new AgentClient(config);
  }

  /**
   * Verify an agent is responding after a deploy/restart.
   * Retries with configurable backoff: waits `delays[i]` ms before each attempt.
   *
   * Delay schedule resolution order (first wins):
   *   1. `options.delaysMs` (explicit override, used in tests)
   *   2. `agent.docker.health_check_delays_ms` (per-agent in agents.yaml)
   *   3. `config.deploy.health_check_delays_ms` (global in agents.yaml)
   *   4. `HEALTH_CHECK_DELAYS_MS` (built-in default: [3s, 10s, 20s, 30s, 45s, 60s] = 168s)
   *
   * Returns true if the agent responds within the retry window, false otherwise.
   */
  async healthCheck(
    agentName: string,
    options?: { maxRetries?: number; delaysMs?: number[] },
  ): Promise<boolean> {
    const agentCfg = this.config.agents[agentName];
    const delays =
      options?.delaysMs ??
      agentCfg?.docker?.health_check_delays_ms ??
      this.config.deploy?.health_check_delays_ms ??
      HEALTH_CHECK_DELAYS_MS;
    const maxRetries = options?.maxRetries ?? delays.length;

    this.log.info("Starting health check", { agentName, maxRetries, totalWindowMs: delays.reduce((a, b) => a + b, 0) });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Wait before each attempt (gives container time to initialise on attempt 0)
      const waitMs = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((res) => setTimeout(res, waitMs));

      const { alive, errorType } = await this.agentClient.pingWithDetail(agentName);
      if (alive) {
        this.log.info("Health check passed", { agentName, attempt: attempt + 1 });
        return true;
      }
      this.log.warn("Health check attempt failed", { agentName, attempt: attempt + 1, maxRetries, errorType });
    }

    return false;
  }

  /**
   * Redeploy a specific agent by triggering a rebuild via the management API.
   */
  async redeploy(agentName: string): Promise<DeployResult> {
    const agent = this.config.agents[agentName];
    if (!agent) {
      return { agentName, action: "error", detail: `Unknown agent: ${agentName}` };
    }

    const repoName = agent.repo ? agent.repo.replace(/.*\//, "").replace(/\.git$/, "") : undefined;
    const project = agent.repo
      ? `/home/claude/workspace/${repoName}`
      : resolve(this.config.base_dir, agent.dir);

    try {
      await this.management.updateAgent(agentName, {
        project,
        repo: agent.repo,
        port: agent.docker?.port ?? 3460,
        permissions: agent.docker?.permissions ?? "auto",
        session: agent.docker?.session ?? "fresh",
        sshKey: this.config.proxy.ssh_key,
        ghToken: this.config.proxy.gh_token,
        provider: agent.provider,
      });
      this.markDeployed(agentName);
      this.log.info("Agent redeployed", { agentName });

      // Verify the agent is actually responding after the rebuild
      const healthy = await this.healthCheck(agentName);
      if (!healthy) {
        this.log.warn("Agent failed health check after redeploy — may be broken", { agentName });
        return {
          agentName,
          action: "health-check-failed",
          detail: "Container rebuild triggered but agent did not respond to health check",
        };
      }

      const warmupMs = this.config.deploy?.post_restart_warmup_ms ?? POST_RESTART_WARMUP_MS;
      await new Promise((r) => setTimeout(r, warmupMs));
      this.log.info("Post-redeploy warmup complete", { agentName, warmupMs });

      return { agentName, action: "redeployed", detail: "Container rebuild triggered" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If the management API doesn't know about this agent, re-register and retry once
      if (msg.includes("not found") || msg.includes("404")) {
        this.log.info("Agent not found on proxy, re-registering", { agentName });
        const registered = await this.ensureRegistered(agentName);
        if (registered) return this.redeploy(agentName);
      }
      this.log.error("Redeploy failed", { agentName, error: msg });
      return { agentName, action: "error", detail: msg };
    }
  }

  /**
   * Restart an agent's container (stop + start). For repo-based agents, the
   * entrypoint script will pull latest main on startup.
   */
  async restartAgent(agentName: string): Promise<DeployResult> {
    try {
      await this.management.stopAgent(agentName);
      await this.management.startAgent(agentName);
      this.log.info("Agent restarted", { agentName });

      // Verify the agent is actually responding after the restart
      const healthy = await this.healthCheck(agentName);
      if (!healthy) {
        this.log.warn("Agent failed health check after restart — may be broken", { agentName });
        return {
          agentName,
          action: "health-check-failed",
          detail: "Container restarted but agent did not respond to health check",
        };
      }

      // Post-restart warmup: the health check only verifies the HTTP port is
      // up, but the entrypoint may still be running git pull / CLI init.
      // Wait a few seconds so the next dispatch cycle doesn't hit a half-ready
      // container (the spawn-on-startup race from issue #488).
      const restartWarmupMs = this.config.deploy?.post_restart_warmup_ms ?? POST_RESTART_WARMUP_MS;
      await new Promise((r) => setTimeout(r, restartWarmupMs));
      this.log.info("Post-restart warmup complete", { agentName, warmupMs: restartWarmupMs });

      return { agentName, action: "redeployed", detail: "Container restarted (pull on start)" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found") || msg.includes("404")) {
        this.log.info("Agent not found on proxy, re-registering", { agentName });
        const registered = await this.ensureRegistered(agentName);
        if (registered) return this.restartAgent(agentName);
      }
      this.log.error("Restart failed", { agentName, error: msg });
      return { agentName, action: "error", detail: msg };
    }
  }

  /**
   * Get names of agents that are actually registered on the proxy.
   */
  async getRegisteredAgents(): Promise<Set<string>> {
    try {
      const agents = await this.management.listAgents();
      return new Set(agents.map((a) => a.name));
    } catch {
      return new Set();
    }
  }

  /**
   * Probe an agent's /secrets/health endpoint to determine whether its required
   * secrets (oauth_token, gh_token) are mounted and readable.
   *
   * Called during the auto-recovery playbook to distinguish "agent process
   * crashed" from "agent started but can't authenticate" — the recovery action
   * differs in each case.
   *
   * Returns `reachable: false` when the agent's HTTP port is not responding
   * (e.g. the container is stopped).  Returns `healthy: false` with
   * `unhealthySecrets` populated when the port is up but secrets are missing.
   */
  async checkSecretsHealth(agentName: string): Promise<SecretsHealthResult> {
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    if (!baseUrl) {
      return { reachable: false, healthy: false, unhealthySecrets: [], mountDetails: [], error: "no port configured" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${baseUrl}/secrets/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 200 = all healthy, 207 = some unhealthy — both are valid JSON responses
      if (!res.ok && res.status !== 207) {
        return { reachable: true, healthy: false, unhealthySecrets: [], mountDetails: [], error: `HTTP ${res.status}` };
      }

      const data = await res.json() as {
        healthy: boolean;
        secrets?: Array<{ name: string; readable: boolean; non_empty: boolean; mount_status?: string }>;
      };

      // Classify each secret into one of three distinct mount states.
      // The agent may already return a `mount_status` field (newer agents); if
      // not, we derive the state from the existing `readable` + `non_empty`
      // flags so the orchestrator is backward-compatible.
      const mountDetails: SecretMountDetail[] = (data.secrets ?? []).map((s) => {
        let status: SecretMountStatus;
        let reason: string;

        if (s.mount_status === "present-and-valid" || s.mount_status === "mounted-but-empty" || s.mount_status === "not-mounted") {
          // Agent already classified the state — trust it.
          status = s.mount_status as SecretMountStatus;
          reason =
            status === "present-and-valid"
              ? "secret is mounted and readable"
              : status === "mounted-but-empty"
                ? "file exists but has no content (misconfigured mount or injector not yet run)"
                : "file not found or unreadable (ENOENT — secret was never injected)";
        } else if (!s.readable) {
          // Older agent: readable=false means ENOENT or permission error.
          status = "not-mounted";
          reason = "file not found or unreadable (ENOENT — secret was never injected)";
        } else if (!s.non_empty) {
          // Older agent: readable=true but empty content.
          status = "mounted-but-empty";
          reason = "file exists but has no content (misconfigured mount or injector not yet run)";
        } else {
          status = "present-and-valid";
          reason = "secret is mounted and readable";
        }

        return { name: s.name, status, reason };
      });

      const unhealthySecrets = mountDetails
        .filter((d) => d.status !== "present-and-valid")
        .map((d) => d.name);

      return { reachable: true, healthy: data.healthy, unhealthySecrets, mountDetails };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      return { reachable: false, healthy: false, unhealthySecrets: [], mountDetails: [], error: msg };
    }
  }

  /**
   * Check which repo-based agents have new commits on their remote deploy branch
   * since the last time they were restarted by the orchestrator.
   * Uses `gh api` to query the remote HEAD SHA (no local clone needed).
   * The branch is determined by `agent.deploy_branch` (defaults to `"main"`).
   */
  getStaleRepoAgents(registeredAgents?: Set<string>): string[] {
    const stale: string[] = [];

    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (!agent.repo) continue;
      if (!agent.docker?.port) continue;
      if (registeredAgents && !registeredAgents.has(name)) continue;

      // Parse owner/repo from the repo URL or "owner/repo" shorthand
      const repoSlug = parseRepoSlug(agent.repo);
      if (!repoSlug) continue;

      const branch = agent.deploy_branch ?? "main";

      try {
        const remoteSha = execSync(
          `gh api repos/${repoSlug}/commits/${branch} --jq .sha`,
          { encoding: "utf-8", timeout: 10000 },
        ).trim();

        const deployedSha = this.getRepoDeployedSha(name);

        if (deployedSha !== remoteSha) {
          this.log.info("Stale repo agent detected", { agentName: name, deployedSha, remoteSha });
          stale.push(name);
        }
      } catch (err) {
        // Network error, repo not found, etc. — skip silently
        this.log.warn("Could not check remote SHA for repo agent", {
          agentName: name,
          repo: agent.repo,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return stale;
  }

  /**
   * Restart all stale repo-based agents (those whose remote main has new commits).
   */
  async restartStaleRepoAgents(registeredAgents?: Set<string>): Promise<DeployResult[]> {
    const stale = this.getStaleRepoAgents(registeredAgents);
    const results: DeployResult[] = [];

    for (const name of stale) {
      const result = await this.restartAgent(name);
      if (result.action === "redeployed") {
        // Record the current remote SHA so we don't restart again until new commits arrive
        const agent = this.config.agents[name];
        const repoSlug = agent?.repo ? parseRepoSlug(agent.repo) : null;
        if (repoSlug) {
          const branch = agent?.deploy_branch ?? "main";
          try {
            const remoteSha = execSync(
              `gh api repos/${repoSlug}/commits/${branch} --jq .sha`,
              { encoding: "utf-8", timeout: 10000 },
            ).trim();
            this.markRepoDeployed(name, remoteSha);
          } catch {
            // Best effort
          }
        }
      }
      results.push(result);
    }

    return results;
  }

  /**
   * Get the last-deployed SHA for a repo-based agent, stored in
   * ~/.claude-orchestrator/repo-deploy-shas/<agentName>.
   */
  private getRepoDeployedSha(agentName: string): string | null {
    try {
      return readFileSync(resolve(REPO_SHA_DIR, agentName), "utf-8").trim();
    } catch {
      return null;
    }
  }

  /**
   * Persist the deployed SHA for a repo-based agent.
   */
  markRepoDeployed(agentName: string, sha: string): void {
    try {
      mkdirSync(REPO_SHA_DIR, { recursive: true });
      writeFileSync(resolve(REPO_SHA_DIR, agentName), sha);
    } catch {
      // Best effort
    }
  }

  /**
   * Check which agents have new commits since their container was last deployed.
   * Only checks agents that are actually registered on the proxy.
   */
  getStaleAgents(registeredAgents?: Set<string>): string[] {
    const stale: string[] = [];

    for (const [name, agent] of Object.entries(this.config.agents)) {
      if (!agent.docker?.port) continue;
      if (registeredAgents && !registeredAgents.has(name)) continue;
      // Repo-based agents sync via container restart, not host SHA comparison
      if (agent.repo) continue;

      const dir = resolve(this.config.base_dir, agent.dir);
      try {
        const currentSha = execSync("git rev-parse HEAD", {
          cwd: dir, encoding: "utf-8", timeout: 5000,
        }).trim();

        const markerFile = resolve(dir, ".orchestrator-deploy-sha");
        let deployedSha: string | null = null;
        try {
          deployedSha = readFileSync(markerFile, "utf-8").trim();
        } catch {
          // No marker = never deployed by orchestrator
        }

        if (deployedSha !== currentSha) {
          stale.push(name);
        }
      } catch {
        // Not a git repo or other error — skip
      }
    }

    return stale;
  }

  /**
   * Re-register an agent with the proxy management API.
   * Called when the proxy has lost its in-memory agent state (e.g. after restart).
   */
  private async ensureRegistered(agentName: string): Promise<boolean> {
    const agent = this.config.agents[agentName];
    if (!agent) return false;
    try {
      const proxyConfig: ProxyAgentConfig = {
        name: agentName,
        project: resolve(this.config.base_dir, agent.dir),
        repo: agent.repo,
        port: agent.docker?.port ?? 3460,
        permissions: agent.docker?.permissions ?? "auto",
        session: agent.docker?.session ?? "fresh",
        sshKey: this.config.proxy.ssh_key,
        ghToken: this.config.proxy.gh_token,
        provider: agent.provider,
        apiKey: agent.docker?.api_key ?? "",
      };
      await this.management.createAgent(proxyConfig);
      this.log.info("Agent re-registered with proxy", { agentName });
      return true;
    } catch (err) {
      this.log.error("Failed to re-register agent", { agentName, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  }

  /**
   * Mark an agent as deployed at the current commit.
   */
  private markDeployed(agentName: string): void {
    const agent = this.config.agents[agentName];
    if (!agent) return;

    const dir = resolve(this.config.base_dir, agent.dir);
    try {
      const currentSha = execSync("git rev-parse HEAD", {
        cwd: dir, encoding: "utf-8", timeout: 5000,
      }).trim();
      writeFileSync(resolve(dir, ".orchestrator-deploy-sha"), currentSha);
    } catch {
      // Best effort
    }
  }

  /**
   * Check and redeploy all stale agents (both local-dir and repo-based).
   */
  async redeployStale(registeredAgents?: Set<string>): Promise<DeployResult[]> {
    const stale = this.getStaleAgents(registeredAgents);
    const results: DeployResult[] = [];

    for (const name of stale) {
      const result = await this.redeploy(name);
      results.push(result);
    }

    // Also restart repo-based agents that have new remote commits
    const repoResults = await this.restartStaleRepoAgents(registeredAgents);
    results.push(...repoResults);

    return results;
  }
}

/**
 * Parse a repo slug ("owner/repo") from a full URL or shorthand.
 * Handles: "https://github.com/owner/repo.git", "git@github.com:owner/repo.git", "owner/repo"
 */
export function parseRepoSlug(repo: string): string | null {
  // Full HTTPS URL
  const httpsMatch = repo.match(/github\.com\/([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return httpsMatch[1];

  // SSH URL
  const sshMatch = repo.match(/github\.com:([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // Already a slug like "owner/repo"
  if (/^[^/]+\/[^/]+$/.test(repo)) return repo.replace(/\.git$/, "");

  return null;
}
