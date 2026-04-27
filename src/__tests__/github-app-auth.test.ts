import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GitHubAppTokenClient,
  buildGitHubAppRuntimeEnv,
  resolveGitHubAppIdentitySummary,
} from "../github-app-auth.js";

function makePrivateKeyPem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
  return privateKey.export({ type: "pkcs1", format: "pem" }).toString();
}

describe("GitHubAppTokenClient", () => {
  it("caches installation tokens until they are near expiry", async () => {
    const privateKeyPem = makePrivateKeyPem();
    let nowMs = 0;
    let fetchCalls = 0;

    const client = new GitHubAppTokenClient(
      {
        appId: 123,
        installationId: 456,
        privateKeyPem,
      },
      {
        now: () => nowMs,
        refreshSkewMs: 5 * 60 * 1000,
        fetchImpl: async () => {
          fetchCalls++;
          return new Response(
            JSON.stringify({
              token: `token-${fetchCalls}`,
              expires_at: new Date(nowMs + 30 * 60 * 1000).toISOString(),
            }),
            {
              status: 201,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    );

    const first = await client.getInstallationToken();
    const second = await client.getInstallationToken();

    expect(first.token).toBe("token-1");
    expect(second.token).toBe("token-1");
    expect(fetchCalls).toBe(1);

    nowMs = 26 * 60 * 1000;
    const refreshed = await client.getInstallationToken();

    expect(refreshed.token).toBe("token-2");
    expect(fetchCalls).toBe(2);
  });
});

describe("GitHub App runtime env helpers", () => {
  it("builds a per-agent gh/git environment from an installation token", () => {
    const env = buildGitHubAppRuntimeEnv("ghs_test_token", {
      botName: "Claude Reviewer",
      botEmail: "claude-reviewer@users.noreply.github.com",
      botLogin: "claude-reviewer[bot]",
    });

    expect(env.GH_TOKEN).toBe("ghs_test_token");
    expect(env.GITHUB_TOKEN).toBe("ghs_test_token");
    expect(env.GIT_AUTHOR_NAME).toBe("Claude Reviewer");
    expect(env.GIT_COMMITTER_EMAIL).toBe("claude-reviewer@users.noreply.github.com");
  });

  it("summarises the configured identity for logs", () => {
    const summary = resolveGitHubAppIdentitySummary({
      appId: 123,
      installationId: 456,
      botName: "Claude Reviewer",
      botLogin: "claude-reviewer[bot]",
      botEmail: "claude-reviewer@users.noreply.github.com",
    });

    expect(summary).toContain("name=Claude Reviewer");
    expect(summary).toContain("login=claude-reviewer[bot]");
    expect(summary).toContain("email=claude-reviewer@users.noreply.github.com");
    expect(summary).toContain("installation=456");
  });
});
