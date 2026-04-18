import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync, cpSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { StateStore } from "../state/store.js";

export interface BootstrapOptions {
  name: string;
  description: string;
  capabilities: string[];
  topics?: string[];
  remote?: string;
  port?: number;
  /** Name of most similar existing agent — seeds LEARNINGS.md and permissions. */
  similarAgent?: string;
  /** Explicit scope: what this agent owns. */
  scopeOwns?: string[];
  /** Explicit scope: what this agent does NOT own. */
  scopeExcludes?: string[];
  /** Whether to auto-create a Codex pool variant (default: false — Codex currently out of tokens). */
  createCodexVariant?: boolean;
  /** Pool name (defaults to agent name). */
  pool?: string;
  /** Monthly goal IDs this agent contributes to. */
  goalIds?: string[];
}

export interface BootstrapResult {
  path: string;
  registered: boolean;
  remoteSet: boolean;
  codexVariantCreated: boolean;
}

export class Bootstrapper {
  private log = createLogger("bootstrapper");

  constructor(
    private config: OrchestratorConfig,
    private store?: StateStore,
  ) {}

  create(options: BootstrapOptions, configPath: string): BootstrapResult {
    const agentDir = resolve(this.config.base_dir, options.name);

    if (existsSync(agentDir)) {
      throw new Error(`Directory already exists: ${agentDir}`);
    }

    this.log.info("Bootstrapping agent", { name: options.name, dir: agentDir });

    // 1. Copy template or create from scratch
    const templateDir = this.resolveTemplateDir();
    if (templateDir) {
      this.copyTemplate(templateDir, agentDir);
      this.hydrateTemplate(agentDir, options);
    } else {
      mkdirSync(agentDir, { recursive: true });
      writeFileSync(resolve(agentDir, "CLAUDE.md"), this.generateClaudeMd(options));
      writeFileSync(resolve(agentDir, "README.md"), this.generateReadme(options));
      writeFileSync(resolve(agentDir, ".gitignore"), this.generateGitignore());
    }

    // 2. Seed from similar agent
    if (options.similarAgent) {
      this.seedFromSimilarAgent(agentDir, options.similarAgent);
    }

    // 3. Init git repo
    if (!existsSync(resolve(agentDir, ".git"))) {
      execSync("git init -b main", { cwd: agentDir, stdio: "ignore" });
    }

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
    const port = options.port ?? this.nextAvailablePort();
    this.registerInConfig(options, configPath, port);

    // 7. Auto-create Codex variant
    let codexVariantCreated = false;
    if (options.createCodexVariant === true) {
      const codexPort = port + 1;
      this.registerCodexVariant(options, configPath, codexPort);
      codexVariantCreated = true;
    }

    this.log.info("Agent bootstrapped", {
      name: options.name,
      path: agentDir,
      remoteSet,
      codexVariant: codexVariantCreated,
    });

    return { path: agentDir, registered: true, remoteSet, codexVariantCreated };
  }

  // ── Template handling ───────────────────────────────────────────────────────

  private resolveTemplateDir(): string | null {
    // Check config, then default location
    const candidates = [
      this.config.template_dir,
      resolve(this.config.base_dir, "agent-template"),
    ].filter(Boolean) as string[];

    for (const dir of candidates) {
      if (existsSync(resolve(dir, "CLAUDE.md"))) return dir;
    }
    return null;
  }

  private copyTemplate(templateDir: string, targetDir: string): void {
    mkdirSync(targetDir, { recursive: true });

    // Copy all template contents
    const entries = readdirSync(templateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const src = join(templateDir, entry.name);
      const dest = join(targetDir, entry.name);
      cpSync(src, dest, { recursive: true });
    }

    this.log.info("Copied template", { from: templateDir, to: targetDir });
  }

  private hydrateTemplate(agentDir: string, options: BootstrapOptions): void {
    const claudeMdPath = resolve(agentDir, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) return;

    let content = readFileSync(claudeMdPath, "utf-8");

    // Replace placeholders
    content = content.replace(/\{Agent Name\}/g, options.name);
    content = content.replace(/\{agent-name\}/g, options.name);

    // Fill "What this agent does" section
    content = content.replace(
      /<!-- TODO: 1-3 sentences[^>]*-->/,
      options.description,
    );

    // Fill scope sections
    const ownsTopics = options.scopeOwns ?? options.topics ?? options.capabilities;
    const excludes = options.scopeExcludes ?? this.deriveExclusions(ownsTopics);

    // Replace Owns section (including any TODO comment after it)
    content = content.replace(
      /\*\*Owns:\*\*[\s\S]*?(?=\*\*Does not own)/,
      `**Owns:** ${ownsTopics.join(", ")}\n\n`,
    );
    // Replace Does not own section (including any TODO comment after it)
    content = content.replace(
      /\*\*Does not own:\*\*[\s\S]*?(?=\n##)/,
      `**Does not own:** ${excludes.join(", ")}\n`,
    );

    writeFileSync(claudeMdPath, content);
  }

  private deriveExclusions(ownedTopics: string[]): string[] {
    // List other agents' topics that this agent does NOT own
    const ownedSet = new Set(ownedTopics.map((t) => t.toLowerCase()));
    const otherTopics = new Set<string>();
    for (const agent of Object.values(this.config.agents)) {
      for (const topic of agent.owns_topics ?? []) {
        if (!ownedSet.has(topic.toLowerCase())) {
          otherTopics.add(topic);
        }
      }
    }
    return [...otherTopics].slice(0, 10); // cap to keep it readable
  }

  // ── Seed from similar agent ─────────────────────────────────────────────────

  private seedFromSimilarAgent(agentDir: string, similarAgentName: string): void {
    const similarAgent = this.config.agents[similarAgentName];
    if (!similarAgent) {
      this.log.warn("Similar agent not found in config", { similarAgentName });
      return;
    }

    // Copy permissions from similar agent
    const similarDir = resolve(this.config.base_dir, similarAgent.dir);
    const permissionsPath = resolve(similarDir, ".claude", "settings.local.json");
    if (existsSync(permissionsPath)) {
      const targetPermDir = resolve(agentDir, ".claude");
      mkdirSync(targetPermDir, { recursive: true });
      cpSync(permissionsPath, resolve(targetPermDir, "settings.local.json"));
      this.log.info("Copied permissions from similar agent", { from: similarAgentName });
    }

    // Seed learned rules if store is available
    if (this.store && similarAgent.github) {
      const rules = this.store.getLearnedRulesForRepo(similarAgent.github, 20);
      if (rules.length > 0) {
        const docsDir = resolve(agentDir, "docs");
        mkdirSync(docsDir, { recursive: true });

        const learnings = rules
          .filter((r) => ["testing", "workflow", "security"].includes(r.category))
          .map((r) => `- ${r.rule} _(from ${r.source}, confidence: ${Math.round(r.confidence * 100)}%)_`);

        const patterns = rules
          .filter((r) => ["architecture", "convention", "style"].includes(r.category))
          .map((r) => `- ${r.rule} _(from ${r.source}, confidence: ${Math.round(r.confidence * 100)}%)_`);

        if (learnings.length > 0) {
          const learningsPath = resolve(docsDir, "LEARNINGS.md");
          const existing = existsSync(learningsPath) ? readFileSync(learningsPath, "utf-8") : "# Learnings\n\n";
          writeFileSync(learningsPath, existing + `\n## Seeded from ${similarAgentName}\n\n${learnings.join("\n")}\n`);
        }

        if (patterns.length > 0) {
          const patternsPath = resolve(docsDir, "PATTERNS.md");
          const existing = existsSync(patternsPath) ? readFileSync(patternsPath, "utf-8") : "# Patterns\n\n";
          writeFileSync(patternsPath, existing + `\n## Seeded from ${similarAgentName}\n\n${patterns.join("\n")}\n`);
        }

        this.log.info("Seeded learned rules from similar agent", {
          from: similarAgentName,
          learnings: learnings.length,
          patterns: patterns.length,
        });
      }
    }
  }

  // ── Config registration ─────────────────────────────────────────────────────

  private registerInConfig(options: BootstrapOptions, configPath: string, port: number): void {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;

    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const pool = options.pool ?? options.name;

    agents[options.name] = {
      dir: options.name,
      description: options.description,
      provider: "claude",
      model: "claude-opus-4-6",
      pool,
      capabilities: options.capabilities,
      owns_topics: options.topics ?? options.capabilities,
      ...(options.remote ? {
        repo: options.remote,
        github: extractGithubRepo(options.remote),
      } : {}),
      docker: {
        port,
        api_key: "cheese",
        permissions: "bypassPermissions",
        session: "fresh",
      },
    };

    config.agents = agents;
    writeFileSync(configPath, stringifyYaml(config, { lineWidth: 0 }));
  }

  private registerCodexVariant(options: BootstrapOptions, configPath: string, port: number): void {
    const raw = readFileSync(configPath, "utf-8");
    const config = parseYaml(raw) as Record<string, unknown>;

    const agents = (config.agents ?? {}) as Record<string, unknown>;
    const pool = options.pool ?? options.name;
    const codexName = `codex-${options.name.replace(/^claude-/, "")}`;

    agents[codexName] = {
      dir: options.name, // same dir as Claude variant
      description: `${options.description} (Codex). Parallel throughput + rate limit resilience.`,
      provider: "openai",
      model: "gpt-5.4-mini",
      pool,
      capabilities: options.capabilities,
      owns_topics: [], // Codex variants don't own topics
      ...(options.remote ? { repo: options.remote } : {}),
      docker: {
        port,
        api_key: "cheese",
        permissions: "bypassPermissions",
        session: "fresh",
        health_check_delays_ms: [5000, 10000, 20000, 30000],
      },
    };

    config.agents = agents;
    writeFileSync(configPath, stringifyYaml(config, { lineWidth: 0 }));

    this.log.info("Created Codex variant", { name: codexName, pool, port });
  }

  private nextAvailablePort(): number {
    const usedPorts = Object.values(this.config.agents)
      .map((a) => a.docker?.port)
      .filter((p): p is number => p !== undefined);
    const maxPort = usedPorts.length > 0 ? Math.max(...usedPorts) : 3459;
    return maxPort + 1;
  }

  // ── Fallback generators (when no template available) ────────────────────────

  private generateClaudeMd(options: BootstrapOptions): string {
    const ownsTopics = options.scopeOwns ?? options.topics ?? options.capabilities;
    const excludes = options.scopeExcludes ?? this.deriveExclusions(ownsTopics);

    return `# ${options.name}

## What this agent does

${options.description}

## Scope

**Owns:** ${ownsTopics.join(", ")}

**Does not own:** ${excludes.join(", ")}

## Development Workflow

- **All changes must be made on a feature branch** — never commit directly to \`main\`.
- **Open a PR for each change** — every feature/fix gets its own branch and pull request.
- **Keep PRs focused** — one logical change per PR.
- Every commit: \`Co-Authored-By: ${options.name} <${options.name}@agent>\`

## Git Practices

- Branch naming: \`feat/description\`, \`fix/description\`
- Never force push to main

## Orchestrator Integration

This agent is managed by the [claude-agent-orchestrator](https://github.com/rapartlu/agent-orchestrator).
`;
  }

  private generateReadme(options: BootstrapOptions): string {
    return `# ${options.name}

${options.description}

## Capabilities

${options.capabilities.map((c) => `- ${c}`).join("\n")}

## Managed By

This agent is managed by the [claude-agent-orchestrator](https://github.com/rapartlu/agent-orchestrator).
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
  const sshMatch = remote.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = remote.match(/github\.com\/([^/]+\/[^/.]+)/);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}
