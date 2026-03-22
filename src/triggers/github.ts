import { execSync } from "node:child_process";

export interface GitHubIssue {
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
}

export function fetchOpenIssues(repo: string): GitHubIssue[] {
  try {
    const output = execSync(
      `gh api "repos/${repo}/issues?state=open&per_page=50" --jq '[.[] | select(.pull_request == null) | {number, title, body, url: .html_url, labels: [.labels[].name]}]'`,
      { encoding: "utf-8", timeout: 30000 },
    );

    const parsed = JSON.parse(output.trim() || "[]") as Array<{
      number: number;
      title: string;
      body: string | null;
      url: string;
      labels: string[];
    }>;

    return parsed.map((issue) => ({
      repo,
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      url: issue.url,
      labels: issue.labels,
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to fetch issues for ${repo}: ${msg}`);
  }
}
