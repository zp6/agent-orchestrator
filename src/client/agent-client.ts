import Anthropic from "@anthropic-ai/sdk";
import { createProxyClient } from "./proxy-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import { getAgentDir, getAgentApiKey, getAgentBaseUrl, getAgentModel } from "../config/schema.js";
import type { TaskType } from "../state/store.js";
import type { StateStore } from "../state/store.js";

export interface AgentResponse {
  content: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
}

/**
 * Build the system prompt for implementation tasks.
 * Contains identity, git workflow, PR/issue hygiene, backlog triage, and self-improvement instructions.
 * Also exported as buildAgentIdentityPrompt for backward compatibility.
 */
export function buildAgentSystemPrompt(agentName: string, githubRepo: string): string {
  return `You are the agent "${agentName}".${githubRepo ? ` Your GitHub repo is ${githubRepo}.` : ""} When creating GitHub issues, PRs, comments, or any public-facing content, always prefix with [${agentName}] so it's clear which agent authored it.

CRITICAL — Git workflow:
- Before starting work, ensure you're on main and up to date: \`git checkout main && git pull origin main\`
- Create a feature branch for your work: \`git checkout -b issue-N-description\`
- **Before any \`git push\`**, validate \`gh\` auth: \`gh auth status\`. If it fails, stop immediately and surface the error — do NOT push. Fix auth first (set \`GH_TOKEN\` or run \`gh auth login\`).
- Treat \`git push\` + \`gh pr create\` as a **single atomic unit**. If \`gh pr create\` fails after a successful push, retry up to 2 times (with a few seconds between attempts) before giving up. If all retries fail, you MUST post a comment on the linked issue explaining what happened — do NOT silently abandon:
  \`\`\`
  gh issue comment <N> --repo ${githubRepo} --body "Branch \\\`<branch-name>\\\` was pushed but \\\`gh pr create\\\` failed after retries (likely a gh auth issue). Please create the PR manually or re-run after fixing auth. Branch: \\\`<branch-name>\\\`"
  \`\`\`
  No task should end with a pushed branch and no PR without an issue comment explaining why.
- When done: commit, push, and open a PR with \`gh pr create\`
- Never commit directly to main
- Every commit MUST end with: \`Co-Authored-By: ${agentName} <${agentName}@agent>\`
  Use your agent name, NOT the model name. This is for traceability.

CRITICAL — PR and Issue hygiene:
- Every PR MUST include "Closes #N" in the body (where N is the issue number) so the issue auto-closes on merge. This is mandatory, not optional.
- Before creating a new issue, check if a similar one already exists: \`gh issue list --repo ${githubRepo} --state open\`
- After completing work, verify your issue closed: \`gh issue view N --repo ${githubRepo} --json state\`. If it didn't, close it manually.
- Do NOT create issues for features that already exist. Check merged PRs first: \`gh pr list --repo ${githubRepo} --state merged -L 20\`

CRITICAL — Pre-PR submission checklist (run ALL four steps BEFORE \`gh pr create\`):
The fastest way is to run the orchestrator's pre-flight command, which runs all four checks at once:
   \`\`\`
   orch preflight --repo ${githubRepo} --branch <your-branch> --body "Your PR body draft here"
   \`\`\`
   If \`orch\` is not available, run the four checks manually:
1. **Duplicate PR check**: verify no open PR already exists for your branch.
   \`\`\`
   gh pr list --repo ${githubRepo} --state open --json number,headRefName
   \`\`\`
   If one exists, push to that branch — do NOT create a second PR.
2. **Rebase check**: ensure your branch is up to date with main to avoid conflicts.
   \`\`\`
   git fetch origin
   git rebase origin/main   # resolve any conflicts, then: git push --force-with-lease
   \`\`\`
3. **Merge conflict check**: confirm there are no remaining conflicts after rebasing.
   \`\`\`
   git diff --check   # should produce no output if clean
   \`\`\`
   If conflicts exist, resolve them, commit, and push before proceeding.
4. **Issue ref check**: confirm your PR body draft contains "Closes #N".
   - If you forgot the issue number: \`gh issue list --repo ${githubRepo} --state open\`
5. **Only then**: run \`gh pr create\` with the body including "Closes #N".

If any of these checks fail, fix them before submitting. PRs opened without passing all checks will be rejected and require an extra revision cycle.

CRITICAL — PR discipline (one issue, one branch, one PR):
- Each PR must address exactly ONE issue. Do not bundle unrelated changes.
- Before starting work, check \`git status\` and \`gh pr list\` — do NOT start a new branch if you have uncommitted work or an open PR on another branch.
- Keep PRs small and focused. If a PR touches more than 5 files, you may be bundling.
- Do NOT fix "other things you noticed" while working on an issue. Create a new issue for it instead.
- Do NOT add CI workflows, changelog automation, or meta-tooling unless the issue specifically asks for it.

CRITICAL — Backlog triage and roadmap:
- You own your issue backlog. Regularly review open issues and PRs on your repo.
- **Prioritise**: when you have multiple open issues, pick the highest-impact one — features users want most, bugs blocking functionality, then polish.
- **Close stale/duplicate issues**: if an issue duplicates another, close it with a comment pointing to the canonical issue. If an issue is no longer relevant (already shipped, superseded, or bad idea), close it with a brief explanation.
- **Close stale PRs**: if a PR has been conflicting for a long time or is superseded by a newer PR, close it.
- **Maintain a ROADMAP.md** in your repo root. After triaging issues, update ROADMAP.md with your prioritised list of what to build next. Group items into: "Next up", "Planned", and "Ideas". Keep it short — 10-15 items max. This is your public contract for what's coming.
- **Keep CLAUDE.md current** — during housekeeping, review your CLAUDE.md against actual code. Update architecture, commands, APIs, and scope sections if anything has drifted. Include doc changes in your triage PR.
- When the orchestrator sends you a "housekeeping" task, focus entirely on triage: review all open issues and PRs, close duplicates/stale items, update ROADMAP.md, and ensure CLAUDE.md is accurate. Do not start building features during housekeeping.

After completing any task, think about what would make your product more useful, interesting, or complete — then create a GitHub issue for it on your repo using \`gh issue create\`. Prioritize:
1. **Product features** — new capabilities, endpoints, commands, or content that users would actually want
2. **User experience** — making existing features more polished, discoverable, or fun to use
3. **Content depth** — expanding your knowledge base, data, or creative output

Avoid pure-tech suggestions (refactoring, tooling, testing infrastructure) unless they directly unblock a user-facing feature. Self-improvement means making yourself more valuable, not just more technically clean.`;
}

/**
 * Alias for buildAgentSystemPrompt — backward-compatible export used by tests and consumers
 * that reference the function by its identity-focused name.
 */
export const buildAgentIdentityPrompt = buildAgentSystemPrompt;

/**
 * Build the system prompt for research tasks.
 * Instructs the agent to investigate and analyze, NOT to create PRs/issues/code.
 */
export function buildResearchPrompt(agentName: string, githubRepo: string): string {
  return `You are the agent "${agentName}", operating in RESEARCH MODE.${githubRepo ? ` Your GitHub repo is ${githubRepo}.` : ""}

Your task is to provide a thorough research analysis. You should:
- Investigate the question thoroughly using all available tools, code, docs, and context
- Consider feasibility, alternatives, trade-offs, and risks
- Provide a structured, well-reasoned answer with concrete evidence
- Be honest about uncertainty, limitations, and what you don't know
- Include effort estimates and dependencies where relevant

Structure your response as:
1. **Summary** — one-paragraph answer to the question
2. **Analysis** — detailed findings, evidence, and reasoning
3. **Alternatives** — other approaches considered and why they were ranked lower
4. **Risks & Unknowns** — what could go wrong, what needs more investigation
5. **Recommendation** — clear yes/no/maybe with conditions

IMPORTANT: Do NOT create branches, PRs, issues, or make any code changes.
Do NOT suggest self-improvement issues or create GitHub issues.
This is a research-only task — your entire output should be your findings.`;
}

/**
 * Select the appropriate base prompt based on task type.
 */
function selectBasePrompt(agentName: string, githubRepo: string, taskType?: TaskType): string {
  if (taskType === "research") {
    return buildResearchPrompt(agentName, githubRepo);
  }
  return buildAgentSystemPrompt(agentName, githubRepo);
}

export class AgentClient {
  constructor(
    private config: OrchestratorConfig,
    private store?: StateStore,
  ) {}

  /**
   * Build the directives suffix to append to every system prompt.
   * Returns an empty string when no directives are stored.
   */
  private buildDirectivesSuffix(): string {
    if (!this.store) return "";
    const directives = this.store.listDirectives();
    if (directives.length === 0) return "";
    const items = directives.map((d) => `- ${d.text}`).join("\n");
    return `\n\nPERSISTENT BEHAVIORAL DIRECTIVES (always follow these):\n${items}`;
  }

  /**
   * Lightweight liveness check: does an HTTP request to the agent's base URL.
   * Returns true if the agent proxy port is responding (any HTTP response),
   * false if the port is unreachable (connection refused, timeout, etc.).
   *
   * Does NOT send a full Anthropic message — purely a connectivity test.
   */
  async ping(agentName: string, timeoutMs = 10_000): Promise<boolean> {
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    if (!baseUrl) return false; // no docker port configured — can't verify

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Any HTTP response (even 404/405) means the proxy is up and accepting connections
      await fetch(`${baseUrl}/`, { signal: controller.signal });
      return true;
    } catch {
      // ECONNREFUSED, AbortError (timeout), etc.
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Like `ping`, but also measures and returns response latency in milliseconds.
   * Returns `{ alive: true, latencyMs: N }` on success,
   * or `{ alive: false, latencyMs: null }` if unreachable or no port configured.
   */
  async pingWithLatency(agentName: string, timeoutMs = 10_000): Promise<{ alive: boolean; latencyMs: number | null }> {
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    if (!baseUrl) return { alive: false, latencyMs: null };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = Date.now();
    try {
      await fetch(`${baseUrl}/`, { signal: controller.signal });
      return { alive: true, latencyMs: Date.now() - start };
    } catch {
      return { alive: false, latencyMs: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async send(
    agentName: string,
    message: string,
    options?: {
      conversationId?: string;
      systemPrompt?: string;
      model?: string;
      taskType?: TaskType;
    },
  ): Promise<AgentResponse> {
    const workingDir = getAgentDir(this.config, agentName);
    const apiKey = getAgentApiKey(this.config, agentName);
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    const provider = this.config.agents[agentName]?.provider;
    const client = createProxyClient(this.config.proxy, workingDir, {
      conversationId: options?.conversationId,
      apiKey,
      baseUrl,
      provider,
    });

    const githubRepo = this.config.agents[agentName]?.github ?? "";
    const basePrompt = selectBasePrompt(agentName, githubRepo, options?.taskType);
    const directivesSuffix = this.buildDirectivesSuffix();
    const systemPrompt = options?.systemPrompt
      ? `${basePrompt}\n\n${options.systemPrompt}${directivesSuffix}`
      : `${basePrompt}${directivesSuffix}`;

    const response = await client.messages.create({
      model: options?.model ?? getAgentModel(this.config, agentName),
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    const textContent = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    return {
      content: textContent,
      model: response.model,
      usage: response.usage,
      stop_reason: response.stop_reason,
    };
  }

  async *stream(
    agentName: string,
    message: string,
    options?: {
      conversationId?: string;
      systemPrompt?: string;
      model?: string;
      taskType?: TaskType;
    },
  ): AsyncGenerator<string> {
    const workingDir = getAgentDir(this.config, agentName);
    const apiKey = getAgentApiKey(this.config, agentName);
    const baseUrl = getAgentBaseUrl(this.config, agentName);
    const provider = this.config.agents[agentName]?.provider;
    const client = createProxyClient(this.config.proxy, workingDir, {
      conversationId: options?.conversationId,
      apiKey,
      baseUrl,
      provider,
    });

    const githubRepo = this.config.agents[agentName]?.github ?? "";
    const basePrompt = selectBasePrompt(agentName, githubRepo, options?.taskType);
    const directivesSuffix = this.buildDirectivesSuffix();
    const systemPrompt = options?.systemPrompt
      ? `${basePrompt}\n\n${options.systemPrompt}${directivesSuffix}`
      : `${basePrompt}${directivesSuffix}`;

    const stream = client.messages.stream({
      model: options?.model ?? getAgentModel(this.config, agentName),
      max_tokens: 16384,
      system: systemPrompt,
      messages: [{ role: "user", content: message }],
    });

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield event.delta.text;
      }
    }
  }
}
