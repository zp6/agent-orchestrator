import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ManagementClient } from "../client/management-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { createLogger } from "../service/logger.js";

export interface DeployResult {
  agentName: string;
  action: "redeployed" | "up-to-date" | "error";
  detail?: string;
}

export class Deployer {
  private management: ManagementClient;
  private log = createLogger("deployer");

  constructor(private config: OrchestratorConfig) {
    this.management = new ManagementClient(config.proxy);
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
   * Check and redeploy all stale agents.
   */
  async redeployStale(): Promise<DeployResult[]> {
    const stale = this.getStaleAgents();
    const results: DeployResult[] = [];

    for (const name of stale) {
      const result = await this.redeploy(name);
      results.push(result);
    }

    return results;
  }
}
