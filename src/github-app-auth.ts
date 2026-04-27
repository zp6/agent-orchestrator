/**
 * GitHub App authentication helper.
 *
 * This module is intentionally reusable from the orchestrator runtime:
 * it signs a short-lived GitHub App JWT, exchanges it for an installation
 * token, and caches the token until it is near expiry.  Callers can then
 * inject the resulting token into `gh` or any GitHub API client as the
 * per-agent bot identity.
 */

import { createPrivateKey, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

export interface GitHubAppAuthConfig {
  /** GitHub App ID. */
  appId: number;
  /** Installation ID for the target repo or repo set. */
  installationId: number;
  /** PEM-encoded private key for the GitHub App. */
  privateKeyPem?: string;
  /** Optional path to the PEM-encoded private key. */
  privateKeyPath?: string;
  /** Optional API base URL, e.g. GitHub Enterprise. Defaults to github.com. */
  apiBaseUrl?: string;
  /**
   * Optional identity metadata for logs and downstream git config.
   * The token itself controls the GitHub-side author identity.
   */
  botLogin?: string;
  botName?: string;
  botEmail?: string;
}

export interface GitHubInstallationToken {
  token: string;
  expiresAt: Date;
}

export interface GitHubAppTokenClientOptions {
  /**
   * Fetch implementation. Defaults to global `fetch`.
   * Exposed for tests and for environments that need a custom dispatcher.
   */
  fetchImpl?: typeof fetch;
  /** Injected clock used by tests. */
  now?: () => number;
  /** Refresh margin before expiry, in milliseconds. Default: 5 minutes. */
  refreshSkewMs?: number;
}

const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

export class GitHubAppTokenClient {
  private cachedToken: GitHubInstallationToken | undefined;

  constructor(
    private readonly config: GitHubAppAuthConfig,
    private readonly options: GitHubAppTokenClientOptions = {},
  ) {}

  /**
   * Returns a valid installation token, refreshing it when the cache is empty
   * or the cached token is close to expiry.
   */
  async getInstallationToken(): Promise<GitHubInstallationToken> {
    const cached = this.cachedToken;
    if (cached && !this.shouldRefresh(cached.expiresAt)) {
      return cached;
    }

    const fresh = await this.fetchInstallationToken();
    this.cachedToken = fresh;
    return fresh;
  }

  /** Clear the local cache. */
  invalidate(): void {
    this.cachedToken = undefined;
  }

  private shouldRefresh(expiresAt: Date): boolean {
    const now = this.now();
    return expiresAt.getTime() - now <= this.refreshSkewMs();
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private refreshSkewMs(): number {
    return this.options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  }

  private async fetchInstallationToken(): Promise<GitHubInstallationToken> {
    const jwt = signGitHubAppJwt(this.config, this.now());
    const apiBaseUrl = (this.config.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    const url = `${apiBaseUrl}/app/installations/${this.config.installationId}/access_tokens`;
    const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;

    if (typeof fetchImpl !== "function") {
      throw new Error("GitHubAppTokenClient requires fetch support");
    }

    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const body = await safeReadBody(response);
      throw new Error(
        `GitHub installation token request failed (${response.status} ${response.statusText})${body ? `: ${body}` : ""}`,
      );
    }

    const payload = (await response.json()) as { token?: string; expires_at?: string };
    if (!payload.token || !payload.expires_at) {
      throw new Error("GitHub installation token response missing token or expires_at");
    }

    const expiresAt = new Date(payload.expires_at);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new Error(`Invalid GitHub installation token expiry: ${payload.expires_at}`);
    }

    return {
      token: payload.token,
      expiresAt,
    };
  }
}

/**
 * Create the token payload that should be injected into a per-agent runtime.
 * The caller can pass the resulting env to `gh`, `git`, and any GitHub API
 * clients so that all GitHub operations are authored by the agent's bot
 * identity rather than a shared operator PAT.
 */
export function buildGitHubAppRuntimeEnv(
  token: string,
  identity?: Pick<GitHubAppAuthConfig, "botLogin" | "botName" | "botEmail">,
): NodeJS.ProcessEnv {
  return {
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    ...(identity?.botName ? { GIT_AUTHOR_NAME: identity.botName, GIT_COMMITTER_NAME: identity.botName } : {}),
    ...(identity?.botEmail ? { GIT_AUTHOR_EMAIL: identity.botEmail, GIT_COMMITTER_EMAIL: identity.botEmail } : {}),
  };
}

export function resolveGitHubAppIdentitySummary(config: GitHubAppAuthConfig): string {
  const pieces = [
    config.botName ? `name=${config.botName}` : undefined,
    config.botLogin ? `login=${config.botLogin}` : undefined,
    config.botEmail ? `email=${config.botEmail}` : undefined,
    `installation=${config.installationId}`,
  ].filter(Boolean);
  return pieces.join(", ");
}

function signGitHubAppJwt(config: GitHubAppAuthConfig, nowMs: number): string {
  const pem = getPrivateKeyPem(config);
  const key = createPrivateKey(pem);
  const iat = Math.floor(nowMs / 1000) - 60;
  const exp = iat + 9 * 60;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat,
    exp,
    iss: config.appId,
  });
  const unsigned = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(key).toString("base64url");
  return `${unsigned}.${signature}`;
}

function getPrivateKeyPem(config: GitHubAppAuthConfig): string {
  if (config.privateKeyPem) {
    return config.privateKeyPem;
  }
  if (config.privateKeyPath) {
    return readFileSync(config.privateKeyPath, "utf-8");
  }
  throw new Error("GitHubAppAuthConfig requires privateKeyPem or privateKeyPath");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    return (await response.text()).trim();
  } catch {
    return "";
  }
}
