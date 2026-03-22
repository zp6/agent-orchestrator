import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";

export interface BootstrapOptions {
  name: string;
  description: string;
  capabilities: string[];
  topics?: string[];
  remote?: string;
  port?: number;
}

export interface BootstrapResult {
  path: string;
  registered: boolean;
  remoteSet: boolean;
}

export class Bootstrapper {
  private log = createLogger("bootstrapper");

  constructor(private config: OrchestratorConfig) {}

  create(options: BootstrapOptions, configPath: string): BootstrapResult {
    const agentDir = resolve(this.config.base_dir, options.name);

    if (existsSync(agentDir)) {
      throw new Error(`Directory already exists: ${agentDir}`);
    }

    this.log.info("Bootstrapping agent", { name: options.name, dir: agentDir });

    // 1. Create directory
    mkdirSync(agentDir, { recursive: true });

    // 2. Init git repo
    execSync("git init -b main", { cwd: agentDir, stdio: "ignore" });

    // 3. Generate files
    writeFileSync(resolve(agentDir, "CLAUDE.md"), this.generateClaudeMd(options));
    writeFileSync(resolve(agentDir, "README.md"), this.generateReadme(options));
    writeFileSync(resolve(agentDir, ".gitignore"), this.generateGitignore());

    // 4. Initial commit
    execSync("git add -A && git commit -m 'Initial scaffold from orchestrator'", {
      cwd: agentDir, stdio: "ignore",
    });

    // 5. Set remote if provided
    let remoteSet = false;
    if (options.remote) {
      try {
        execSync(`git remote add origin ${options.remote}`, { cwd: agentDir, stdio: "ignore" });
        remoteSet = true;
      } catch {
        // Remote might already exist
      }
    }

    // 6. Register in agents.yaml
    this.registerInConfig(options, configPath);

    this.log.info("Agent bootstrapped", { name: options.name, path: agentDir, remoteSet });

    return { path: agentDir, registered: true, remoteSet };
  }

  private registerInConfig(options: BootstrapOptions, configPath: string): void {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;

    const agents = (config.agents ?? {}) as Record<string, unknown>;
    agents[options.name] = {
      dir: options.name,
      description: options.description,
      capabilities: options.capabilities,
      owns_topics: options.topics ?? options.capabilities,
      ...(options.remote ? { github: extractGithubRepo(options.remote) } : {}),
      docker: {
        port: options.port ?? this.nextAvailablePort(),
        permissions: "auto",
        session: "continue",
      },
    };

    config.agents = agents;
    writeFileSync(configPath, stringifyYaml(config, { lineWidth: 0 }));
  }

  private nextAvailablePort(): number {
    const usedPorts = Object.values(this.config.agents)
      .map((a) => a.docker?.port)
      .filter((p): p is number => p !== undefined);
    const maxPort = usedPorts.length > 0 ? Math.max(...usedPorts) : 3459;
    return maxPort + 1;
  }

  private generateClaudeMd(options: BootstrapOptions): string {
    return `# ${options.name}

## Identity

You are **${options.name}** — ${options.description}.

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to \`main\`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Write tests for all changes** — every new feature or modification must include tests.
- **Use meaningful commit messages** — describe the "why", not just the "what".
- **Keep PRs focused** — one logical change per PR.

## Git Practices

- Branch naming: \`feat/description\`, \`fix/description\`, \`docs/description\`
- Never force push to main
- Rebase or merge from main before opening a PR

## GitHub Attribution

When creating GitHub issues, PRs, comments, or any public-facing content, always prefix with **[${options.name}]** so it's clear which agent authored it.

## Orchestrator Integration

This agent is managed by the [claude-agent-orchestrator](https://github.com/rapartlu/claude-agent-orchestrator). The orchestrator:
- Dispatches work to you via GitHub issues
- Reviews your PRs (approves, requests changes, or escalates to human)
- Verifies the quality of your completed work
- Monitors your repo for new issues to address

## How You Receive Work

1. The orchestrator creates or detects GitHub issues on your repo
2. You receive the issue content as a dispatch message
3. You do the work: create a branch, implement, commit, push, open a PR
4. The orchestrator reviews the PR and provides feedback
5. Once approved and merged, the orchestrator redeploys your container with the latest code
`;
  }

  private generateReadme(options: BootstrapOptions): string {
    return `# ${options.name}

${options.description}

## Capabilities

${options.capabilities.map((c) => `- ${c}`).join("\n")}

## Managed By

This agent is managed by the [claude-agent-orchestrator](https://github.com/rapartlu/claude-agent-orchestrator).

## Development

All changes go through feature branches and pull requests. See [CLAUDE.md](CLAUDE.md) for workflow details.
`;
  }

  private generateGitignore(): string {
    return `node_modules/
dist/
.env
.DS_Store
*.log
`;
  }
}

function extractGithubRepo(remote: string): string | undefined {
  // git@github.com:owner/repo.git → owner/repo
  const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (sshMatch) return sshMatch[1];
  // https://github.com/owner/repo.git → owner/repo
  const httpsMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}
