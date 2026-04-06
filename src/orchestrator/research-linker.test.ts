import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResearchLinker, RESEARCH_LINK_SOURCE_PREFIX, RESEARCH_LINK_MIN_SCORE } from "./research-linker.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";

const mockCreate = vi.fn();

vi.mock("../client/llm-client.js", () => ({
  createLLMClient: () => ({
    client: { messages: { create: mockCreate } },
    model: "test-model",
  }),
}));

const config: OrchestratorConfig = {
  proxy: { url: "http://localhost:3457", timeout_ms: 5000 },
  orchestrator_dir: "/tmp/orchestrator",
  base_dir: "/projects",
  agents: {
    "claude-proxy": {
      dir: "proxy",
      description: "Proxy server",
      capabilities: ["implementation"],
      owns_topics: ["proxy"],
      github: "rapartlu/agent-proxy",
    },
    "claude-orchestrator": {
      dir: "orchestrator",
      description: "Orchestrator",
      capabilities: ["implementation"],
      owns_topics: ["orchestrator"],
      github: "rapartlu/agent-orchestrator",
    },
    "research-agent": {
      dir: "research",
      description: "Research agent",
      capabilities: ["research"],
      owns_topics: ["research"],
    },
  },
};

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: "test-research-id",
    title: "Research: Scaling patterns",
    description: "Investigate scaling patterns for multi-agent orchestration",
    source: "manual",
    source_ref: null,
    status: "done",
    agent_name: "research-agent",
    conversation_id: null,
    result: "## Findings\nThe proxy needs connection pooling for better scaling.",
    parent_task_id: null,
    step_id: null,
    plan: null,
    task_type: "research",
    verification_status: "approved",
    quality_score: 0.9,
    verification_notes: "Excellent research",
    retry_count: 0,
    next_retry_at: null,
    reported: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function createMockStore() {
  return {
    findTaskBySourceRef: vi.fn().mockReturnValue(undefined),
    createTask: vi.fn().mockReturnValue({ id: "link-task-id" }),
    updateTask: vi.fn(),
    getTask: vi.fn(),
    getRecentVerified: vi.fn().mockReturnValue([]),
  };
}

function createMockIssueCreator() {
  return {
    isDuplicate: vi.fn().mockReturnValue(false),
    createIssue: vi.fn().mockReturnValue({
      repo: "rapartlu/agent-proxy",
      number: 42,
      url: "https://github.com/rapartlu/agent-proxy/issues/42",
    }),
    getOpenOrchestratorIssueCount: vi.fn().mockReturnValue(0),
    getOpenIssueTitles: vi.fn().mockReturnValue([]),
    titleSimilarity: vi.fn().mockReturnValue(0),
    createAcrossRepos: vi.fn().mockReturnValue([]),
  };
}

describe("ResearchLinker", () => {
  let mockStore: ReturnType<typeof createMockStore>;
  let mockIssueCreator: ReturnType<typeof createMockIssueCreator>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStore = createMockStore();
    mockIssueCreator = createMockIssueCreator();
  });

  describe("linkResearchToImplementation", () => {
    it("analyzes approved research tasks and files implementation issues", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify([{
            title: "Add connection pooling to proxy",
            description: "Implement connection pooling for better scaling under load",
            target_repo: "rapartlu/agent-proxy",
            severity: "high",
          }]),
        }],
      });

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const task = makeTask({});
      const created = await linker.linkResearchToImplementation([task]);

      expect(created).toHaveLength(1);
      expect(created[0].repo).toBe("rapartlu/agent-proxy");
      expect(mockIssueCreator.createIssue).toHaveBeenCalledWith(
        "rapartlu/agent-proxy",
        "[Orchestrator] Add connection pooling to proxy",
        expect.stringContaining("Implementation Gap Identified from Research"),
        ["orchestrator", "research-implementation"],
      );
    });

    it("skips tasks below minimum quality score", async () => {
      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const task = makeTask({ quality_score: 0.5 });
      const created = await linker.linkResearchToImplementation([task]);

      expect(created).toHaveLength(0);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("skips non-research tasks", async () => {
      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const task = makeTask({ task_type: "implementation" });
      const created = await linker.linkResearchToImplementation([task]);

      expect(created).toHaveLength(0);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("skips rejected research tasks", async () => {
      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const task = makeTask({ verification_status: "rejected" });
      const created = await linker.linkResearchToImplementation([task]);

      expect(created).toHaveLength(0);
    });

    it("skips already-linked research tasks", async () => {
      mockStore.findTaskBySourceRef.mockReturnValue({ id: "existing-link" });

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const task = makeTask({});
      const created = await linker.linkResearchToImplementation([task]);

      expect(created).toHaveLength(0);
      expect(mockStore.findTaskBySourceRef).toHaveBeenCalledWith(
        "manual",
        `${RESEARCH_LINK_SOURCE_PREFIX}:test-research-id`,
      );
    });

    it("skips duplicate issues via isDuplicate check", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify([{
            title: "Existing improvement",
            description: "Already filed",
            target_repo: "rapartlu/agent-proxy",
            severity: "medium",
          }]),
        }],
      });
      mockIssueCreator.isDuplicate.mockReturnValue(true);

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const created = await linker.linkResearchToImplementation([makeTask({})]);

      expect(created).toHaveLength(0);
      expect(mockIssueCreator.createIssue).not.toHaveBeenCalled();
    });

    it("skips gaps targeting unknown repos", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify([{
            title: "Fix something",
            description: "In unknown repo",
            target_repo: "rapartlu/unknown-repo",
            severity: "low",
          }]),
        }],
      });

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const created = await linker.linkResearchToImplementation([makeTask({})]);

      expect(created).toHaveLength(0);
    });

    it("records link attempt even when no gaps found", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: "[]" }],
      });

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      await linker.linkResearchToImplementation([makeTask({})]);

      expect(mockStore.createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          source: "manual",
          source_ref: `${RESEARCH_LINK_SOURCE_PREFIX}:test-research-id`,
          title: expect.stringContaining("[research-link]"),
        }),
      );
    });

    it("handles multiple gaps across different repos", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{
          type: "text",
          text: JSON.stringify([
            {
              title: "Proxy improvement",
              description: "Something for proxy",
              target_repo: "rapartlu/agent-proxy",
              severity: "medium",
            },
            {
              title: "Orchestrator improvement",
              description: "Something for orchestrator",
              target_repo: "rapartlu/agent-orchestrator",
              severity: "high",
            },
          ]),
        }],
      });

      mockIssueCreator.createIssue
        .mockReturnValueOnce({
          repo: "rapartlu/agent-proxy",
          number: 100,
          url: "https://github.com/rapartlu/agent-proxy/issues/100",
        })
        .mockReturnValueOnce({
          repo: "rapartlu/agent-orchestrator",
          number: 200,
          url: "https://github.com/rapartlu/agent-orchestrator/issues/200",
        });

      const linker = new ResearchLinker(config, mockStore as any, mockIssueCreator as any);
      const created = await linker.linkResearchToImplementation([makeTask({})]);

      expect(created).toHaveLength(2);
      expect(mockIssueCreator.createIssue).toHaveBeenCalledTimes(2);
    });
  });

  describe("parseResponse", () => {
    it("parses valid JSON array of gaps", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse(JSON.stringify([
        {
          title: "Add feature X",
          description: "Build X because Y",
          target_repo: "owner/repo",
          severity: "high",
        },
      ]));

      expect(gaps).toHaveLength(1);
      expect(gaps[0].title).toBe("Add feature X");
      expect(gaps[0].severity).toBe("high");
    });

    it("handles markdown-wrapped JSON", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse("```json\n" + JSON.stringify([
        { title: "Fix", description: "Something", target_repo: "o/r", severity: "low" },
      ]) + "\n```");

      expect(gaps).toHaveLength(1);
    });

    it("returns empty array for malformed JSON", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse("Not valid JSON at all");
      expect(gaps).toHaveLength(0);
    });

    it("filters out items missing required fields", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse(JSON.stringify([
        { title: "Valid", description: "Good", target_repo: "o/r", severity: "low" },
        { title: "", description: "Bad title", target_repo: "o/r" },
        { title: "No repo", description: "Missing repo" },
        { description: "No title", target_repo: "o/r" },
      ]));

      expect(gaps).toHaveLength(1);
      expect(gaps[0].title).toBe("Valid");
    });

    it("defaults severity to medium for invalid values", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse(JSON.stringify([
        { title: "X", description: "Y", target_repo: "o/r", severity: "critical" },
      ]));

      expect(gaps[0].severity).toBe("medium");
    });

    it("rejects target_repo without slash", () => {
      const linker = new ResearchLinker(config, {} as any, {} as any);
      const gaps = linker.parseResponse(JSON.stringify([
        { title: "X", description: "Y", target_repo: "noslash", severity: "low" },
      ]));

      expect(gaps).toHaveLength(0);
    });
  });

  describe("RESEARCH_LINK_MIN_SCORE", () => {
    it("is set to 0.8", () => {
      expect(RESEARCH_LINK_MIN_SCORE).toBe(0.8);
    });
  });
});
