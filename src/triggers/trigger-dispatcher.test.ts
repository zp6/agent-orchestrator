import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchGitHubIssues } from "./trigger-dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";

// Mock the github trigger
vi.mock("./github.js", () => ({
  fetchOpenIssues: vi.fn(),
}));

import { fetchOpenIssues } from "./github.js";
const mockFetchIssues = vi.mocked(fetchOpenIssues);

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", manager_url: "http://localhost:3400", timeout_ms: 5000 },
  orchestrator_dir: "/tmp",
  base_dir: "/projects",
  agents: {
    "my-agent": {
      dir: "my-agent",
      description: "Test agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      github: "owner/my-repo",
    },
    "no-github": {
      dir: "no-github",
      description: "No github",
      capabilities: ["test"],
      owns_topics: ["test"],
    },
  },
};

describe("dispatchGitHubIssues", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "my-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("dispatches new issues to owning agent", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "Fix it", url: "https://...", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(result.skipped).toBe(0);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Bug"),
      expect.objectContaining({ agentName: "my-agent", source: "github", sourceRef: "owner/my-repo#1" }),
    );
    expect(mockStore.markProcessed).toHaveBeenCalledWith("github", "owner/my-repo#1", "task-1");
  });

  it("skips already processed issues", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
    ]);

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("skips agents without github field", async () => {
    mockFetchIssues.mockReturnValue([]);

    await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    // Should only be called for "my-agent", not "no-github"
    expect(mockFetchIssues).toHaveBeenCalledTimes(1);
    expect(mockFetchIssues).toHaveBeenCalledWith("owner/my-repo");
  });

  it("collects errors and continues", async () => {
    mockFetchIssues.mockImplementation(() => {
      throw new Error("API rate limit");
    });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");
    expect(result.dispatched).toBe(0);
  });

  it("handles dispatch failure for individual issues", async () => {
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
      { repo: "owner/my-repo", number: 2, title: "Feature", body: "", url: "", labels: [] },
    ]);
    (mockDispatcher.dispatch as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error("Agent down"))
      .mockResolvedValueOnce({ taskId: "task-2", agentName: "my-agent", response: { content: "ok" } });

    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);

    expect(result.dispatched).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Agent down");
  });
});
