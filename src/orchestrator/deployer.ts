import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ManagementClient } from "../client/management-client.js";
import { AgentClient } from "../client/agent-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

const REPO_SHA_DIR = resolve(homedir(), ".claude-orchestrator", "repo-deploy-shas");

export interface DeployResult {
  agentName: string;
  action: "redeployed" | "up-to-date" | "error" | "health-check-failed";
  detail?: string;
}

// Default delays (ms) between health-check attempts: 1s, 3s, 10s
const HEALTH_CHECK_DELAYS_MS = [1_000, 3_000, 10_000];

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
   * Retries with exponential backoff: waits `delays[i]` ms before each attempt.
   * Returns true if the agent responds within the retry window, false otherwise.
   */
  async healthCheck(
    agentName: string,
    options?: { maxRetries?: number; delaysMs?: number[] },
  ): Promise<boolean> {
    const maxRetries = options?.maxRetries ?? HEALTH_CHECK_DELAYS_MS.length;
    const delays = options?.delaysMs ?? HEALTH_CHECK_DELAYS_MS;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      // Wait before each attempt (gives container time to initialise on attempt 0)
      const waitMs = delays[Math.min(attempt, delays.length - 1)];
      await new Promise((res) => setTimeout(res, waitMs));

      const alive = await this.agentClient.ping(agentName);
      if (alive) {
        this.log.info("Health check passed", { agentName, attempt: attempt + 1 });
        return true;
      }
      this.log.warn("Health check attempt failed", { agentName, attempt: attempt + 1, maxRetries });
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

      return { agentName, action: "redeployed", detail: "Container rebuild triggered" };
    } catch (err) {
      this.log.error("Redeploy failed", { agentName, error: err instanceof Error ? err.message : String(err) });
      return { agentName, action: "error", detail: err instanceof Error ? err.message : String(err) };
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

      return { agentName, action: "redeployed", detail: "Container restarted (pull on start)" };
    } catch (err) {
      this.log.error("Restart failed", { agentName, error: err instanceof Error ? err.message : String(err) });
      return { agentName, action: "error", detail: err instanceof Error ? err.message : String(err) };
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
   * Check which repo-based agents have new commits on their remote main branch
   * since the last time they were restarted by the orchestrator.
   * Uses `gh api` to query the remote HEAD SHA (no local clone needed).
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

      try {
        const remoteSha = execSync(
          `gh api repos/${repoSlug}/commits/main --jq .sha`,
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
          try {
            const remoteSha = execSync(
              `gh api repos/${repoSlug}/commits/main --jq .sha`,
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
