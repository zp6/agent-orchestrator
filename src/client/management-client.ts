import type { ProxyConfig } from "../config/schema.js";

export interface ProxyAgentConfig {
  name: string;
  project: string;
  port: number;
  apiKey?: string;
  permissions?: string;
  tunnel?: boolean;
  session?: string;
  sessionId?: string;
  sshKey?: string;
  ghToken?: string;
  packages?: string[];
  allowedTools?: string;
}

export interface ProxyAgentStatus extends ProxyAgentConfig {
  status: string;
}

export interface ManagementResponse {
  name: string;
  port?: number;
  project?: string;
  status: string;
}

export class ManagementClient {
  private baseUrl: string;
  private timeout: number;

  constructor(proxyConfig: ProxyConfig) {
    this.baseUrl = proxyConfig.manager_url ?? "http://localhost:3400";
    this.timeout = proxyConfig.timeout_ms;
  }

  async listAgents(): Promise<ProxyAgentStatus[]> {
    const res = await this.fetch("/v1/agents", { method: "GET" });
    return res as ProxyAgentStatus[];
  }

  async getAgent(name: string): Promise<ProxyAgentStatus> {
    const res = await this.fetch(`/v1/agents/${encodeURIComponent(name)}`, { method: "GET" });
    return res as ProxyAgentStatus;
  }

  async createAgent(config: ProxyAgentConfig): Promise<ManagementResponse> {
    const res = await this.fetch("/v1/agents", {
      method: "POST",
      body: config,
    });
    return res as ManagementResponse;
  }

  async updateAgent(name: string, updates: Partial<ProxyAgentConfig>): Promise<ManagementResponse> {
    const res = await this.fetch(`/v1/agents/${encodeURIComponent(name)}`, {
      method: "PUT",
      body: updates,
    });
    return res as ManagementResponse;
  }

  async deleteAgent(name: string): Promise<ManagementResponse> {
    const res = await this.fetch(`/v1/agents/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    return res as ManagementResponse;
  }

  async startAgent(name: string): Promise<ManagementResponse> {
    const res = await this.fetch(`/v1/agents/${encodeURIComponent(name)}/start`, {
      method: "POST",
    });
    return res as ManagementResponse;
  }

  async stopAgent(name: string): Promise<ManagementResponse> {
    const res = await this.fetch(`/v1/agents/${encodeURIComponent(name)}/stop`, {
      method: "POST",
    });
    return res as ManagementResponse;
  }

  async isReachable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${this.baseUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetch(path: string, options: { method: string; body?: unknown }): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: options.body ? { "Content-Type": "application/json" } : undefined,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });

      const data = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        const error = data.error as { message?: string } | undefined;
        throw new ManagementError(
          error?.message ?? `Request failed with status ${res.status}`,
          res.status,
        );
      }

      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class ManagementError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = "ManagementError";
  }
}
