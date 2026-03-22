import { execSync } from "node:child_process";
import { createLLMClient } from "../client/llm-client.js";
import { createLogger } from "../service/logger.js";
import type { OrchestratorConfig } from "../config/schema.js";

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  repo: string;
  author: string;
  branch: string;
  diff: string;
  files_changed: number;
}

export interface PRReviewResult {
  decision: "approve" | "request-changes" | "escalate";
  comment: string;
  reason: string;
}

const SYSTEM_PROMPT = `You are a code reviewer for a multi-agent system. Review the pull request diff and decide:

1. **approve** — the code is correct, complete, well-structured, and safe to merge
2. **request-changes** — there are specific issues that need fixing (list them)
3. **escalate** — this needs human review (security concerns, architectural decisions, breaking changes, or you're unsure)

Respond with ONLY a JSON object (no markdown, no code fences):
{
  "decision": "approve|request-changes|escalate",
  "comment": "Your review comment to post on the PR",
  "reason": "Brief internal reason for the decision"
}

Be thorough but pragmatic. Approve good work. Don't block on style nitpicks. Escalate when genuinely uncertain.`;

export class PRReviewer {
  private log = createLogger("pr-reviewer");

  constructor(private config: OrchestratorConfig) {}

  async reviewPR(repo: string, prNumber: number): Promise<PRReviewResult> {
    const pr = this.fetchPRInfo(repo, prNumber);
    this.log.info("Reviewing PR", { repo, prNumber, title: pr.title, filesChanged: pr.files_changed });

    const client = createLLMClient(this.config
    );

    const prompt = `## PR #${pr.number}: ${pr.title}\n**Repo:** ${pr.repo}\n**Author:** ${pr.author}\n**Branch:** ${pr.branch}\n**Files changed:** ${pr.files_changed}\n\n### Description\n${pr.body}\n\n### Diff\n\`\`\`diff\n${pr.diff.slice(0, 15000)}\n\`\`\``;

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content
        .filter((b) => b.type === "text")
        .map((b) => "text" in b ? b.text : "")
        .join("");

      const result = this.parseResponse(text);
      this.log.info("PR review complete", { repo, prNumber, decision: result.decision, reason: result.reason });

      // Execute the decision
      await this.executeDecision(repo, prNumber, result);

      return result;
    } catch (err) {
      this.log.error("PR review failed", { repo, prNumber, error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  }

  async reviewOpenPRs(repo: string): Promise<Array<{ prNumber: number; result: PRReviewResult }>> {
    const results: Array<{ prNumber: number; result: PRReviewResult }> = [];

    const prs = this.fetchOpenPRs(repo);
    for (const pr of prs) {
      try {
        const result = await this.reviewPR(repo, pr.number);
        results.push({ prNumber: pr.number, result });
      } catch {
        // Continue reviewing other PRs
      }
    }

    return results;
  }

  private async executeDecision(repo: string, prNumber: number, result: PRReviewResult): Promise<void> {
    switch (result.decision) {
      case "approve":
        try {
          execSync(
            `gh pr review ${prNumber} --repo ${repo} --approve --body ${shellEscape(result.comment)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR approved", { repo, prNumber });
        } catch (err) {
          this.log.error("Failed to approve PR", { repo, prNumber, error: String(err) });
        }
        break;

      case "request-changes":
        try {
          execSync(
            `gh pr review ${prNumber} --repo ${repo} --request-changes --body ${shellEscape(result.comment)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR changes requested", { repo, prNumber });
        } catch (err) {
          this.log.error("Failed to request changes", { repo, prNumber, error: String(err) });
        }
        break;

      case "escalate":
        try {
          // Add human reviewer
          execSync(
            `gh pr edit ${prNumber} --repo ${repo} --add-reviewer rapartlu`,
            { encoding: "utf-8", timeout: 30000 },
          );
          // Leave a comment explaining why
          execSync(
            `gh pr comment ${prNumber} --repo ${repo} --body ${shellEscape(`**Orchestrator escalation:** ${result.comment}`)}`,
            { encoding: "utf-8", timeout: 30000 },
          );
          this.log.info("PR escalated to human", { repo, prNumber, reason: result.reason });
        } catch (err) {
          this.log.error("Failed to escalate PR", { repo, prNumber, error: String(err) });
        }
        break;
    }
  }

  private fetchPRInfo(repo: string, prNumber: number): PRInfo {
    const prJson = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json number,title,body,author,headRefName,changedFiles`,
      { encoding: "utf-8", timeout: 30000 },
    );
    const pr = JSON.parse(prJson);

    const diff = execSync(
      `gh pr diff ${prNumber} --repo ${repo}`,
      { encoding: "utf-8", timeout: 30000 },
    );

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body ?? "",
      repo,
      author: pr.author?.login ?? "unknown",
      branch: pr.headRefName,
      diff,
      files_changed: pr.changedFiles ?? 0,
    };
  }

  private fetchOpenPRs(repo: string): Array<{ number: number; title: string }> {
    const output = execSync(
      `gh pr list --repo ${repo} --state open --json number,title`,
      { encoding: "utf-8", timeout: 30000 },
    );
    return JSON.parse(output);
  }

  private parseResponse(text: string): PRReviewResult {
    const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      const decision = ["approve", "request-changes", "escalate"].includes(parsed.decision)
        ? parsed.decision as PRReviewResult["decision"]
        : "escalate";
      return {
        decision,
        comment: String(parsed.comment ?? ""),
        reason: String(parsed.reason ?? ""),
      };
    } catch {
      return { decision: "escalate", comment: "Could not parse review — escalating to human.", reason: "Parse failure" };
    }
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
