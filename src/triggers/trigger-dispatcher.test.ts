import { describe, it, expect, vi, beforeEach } from "vitest";
import { dispatchGitHubIssues, dispatchLinearChecks, dispatchSlackChecks } from "./trigger-dispatcher.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Dispatcher } from "../orchestrator/dispatcher.js";
import type { StateStore } from "../state/store.js";

vi.mock("./github.js", () => ({
  fetchOpenIssues: vi.fn(),
}));

vi.mock("./reporters.js", () => ({
  reportResult: vi.fn(),
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
    "linear-agent": {
      dir: "linear-agent",
      description: "Linear agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      linear: { teams: ["ENG"] },
    },
    "slack-agent": {
      dir: "slack-agent",
      description: "Slack agent",
      capabilities: ["test"],
      owns_topics: ["test"],
      slack: { channels: ["#eng"], mention_pattern: "@bot" },
    },
    "no-triggers": {
      dir: "no-triggers",
      description: "No triggers",
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
      getTask: vi.fn().mockReturnValue(null),
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
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Bug"),
      expect.objectContaining({ agentName: "my-agent", source: "github", sourceRef: "owner/my-repo#1" }),
    );
  });

  it("skips already processed issues", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    mockFetchIssues.mockReturnValue([
      { repo: "owner/my-repo", number: 1, title: "Bug", body: "", url: "", labels: [] },
    ]);
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips agents without github field", async () => {
    mockFetchIssues.mockReturnValue([]);
    await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(mockFetchIssues).toHaveBeenCalledTimes(1);
    expect(mockFetchIssues).toHaveBeenCalledWith("owner/my-repo");
  });

  it("collects errors and continues", async () => {
    mockFetchIssues.mockImplementation(() => { throw new Error("API rate limit"); });
    const result = await dispatchGitHubIssues(config, mockStore, mockDispatcher);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API rate limit");
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
  });
});

describe("dispatchLinearChecks", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "linear-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("dispatches check to agents with linear config", async () => {
    const result = await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Check Linear"),
      expect.objectContaining({ agentName: "linear-agent", source: "linear" }),
    );
  });

  it("includes team filters in the message", async () => {
    await dispatchLinearChecks(config, mockStore, mockDispatcher);
    const call = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("teams: ENG");
  });

  it("skips when already checked this hour", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips agents without linear config", async () => {
    await dispatchLinearChecks(config, mockStore, mockDispatcher);
    expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
  });
});

describe("dispatchSlackChecks", () => {
  let mockStore: StateStore;
  let mockDispatcher: Dispatcher;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = {
      isProcessed: vi.fn().mockReturnValue(false),
      markProcessed: vi.fn(),
    } as unknown as StateStore;
    mockDispatcher = {
      dispatch: vi.fn().mockResolvedValue({ taskId: "task-1", agentName: "slack-agent", response: { content: "done" } }),
    } as unknown as Dispatcher;
  });

  it("dispatches check to agents with slack config", async () => {
    const result = await dispatchSlackChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(1);
    expect(mockDispatcher.dispatch).toHaveBeenCalledWith(
      expect.stringContaining("Check Slack"),
      expect.objectContaining({ agentName: "slack-agent", source: "slack" }),
    );
  });

  it("includes mention pattern and channels", async () => {
    await dispatchSlackChecks(config, mockStore, mockDispatcher);
    const call = (mockDispatcher.dispatch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toContain("@bot");
    expect(call[0]).toContain("#eng");
  });

  it("skips when already checked this hour", async () => {
    (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const result = await dispatchSlackChecks(config, mockStore, mockDispatcher);
    expect(result.dispatched).toBe(0);
    expect(result.skipped).toBe(1);
  });
});
