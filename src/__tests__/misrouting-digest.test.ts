/**
 * Tests for Reviewer Misrouting Digest (issue #382).
 *
 * Covers:
 *  1. classifyMisroutedTask() — correctly classifies implementation vs cross-repo vs non-misrouted
 *  2. buildMisroutingDigest() — queries store, filters by time window, maps to entries
 *  3. formatMisroutingDigest() — renders expected Markdown structure
 *  4. MisroutingDigestScheduler.maybeFireDigest() — fires once per day, respects hour
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyMisroutedTask,
  buildMisroutingDigest,
  formatMisroutingDigest,
  MisroutingDigestScheduler,
  FLAG_LAST_MISROUTING_DIGEST_SENT,
  REVIEWER_AGENT_NAMES,
} from "../reviewer/misrouting-digest.js";
import type { IMisroutingDigestStore, MisroutingDigestReport } from "../reviewer/misrouting-digest.js";
import type { Task, TaskType } from "../state/types.js";
import type { Notifier } from "../notify.js";
import type { ReviewerConfig } from "../config.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: "Test task",
    status: "done",
    task_type: "implementation" as TaskType,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeConfig(agentOverrides: Record<string, { github?: string }> = {}): ReviewerConfig {
  const defaultAgents: Record<string, { description: string; dir: string; github?: string }> = {
    "claude-agent-orchestrator": {
      description: "Orchestrator",
      dir: "agent-orchestrator",
      github: "rapartlu/agent-orchestrator",
    },
    "claude-orchestrator-reviewer": {
      description: "Reviewer",
      dir: "agent-reviewer",
      github: "rapartlu/agent-reviewer",
    },
    "claude-orchestrator-dashboard": {
      description: "Dashboard",
      dir: "agent-dashboard",
      github: "rapartlu/agent-dashboard",
    },
    "claude-research-agent": {
      description: "Research",
      dir: "research-agent",
      github: "rapartlu/research-agent",
    },
  };

  // Merge overrides
  for (const [name, cfg] of Object.entries(agentOverrides)) {
    if (defaultAgents[name]) {
      Object.assign(defaultAgents[name], cfg);
    } else {
      defaultAgents[name] = { description: name, dir: name, ...cfg };
    }
  }

  return {
    base_dir: "/tmp",
    orchestrator_dir: "/tmp/orch",
    agents: defaultAgents,
  };
}

function makeStore(tasks: Task[] = []): IMisroutingDigestStore & { flags: Map<string, string> } {
  const flags = new Map<string, string>();
  return {
    flags,
    listTasks(opts) {
      return tasks.filter((t) => {
        if (opts.agent_name && t.agent_name !== opts.agent_name) return false;
        if (opts.status && t.status !== opts.status) return false;
        return true;
      }).slice(0, opts.limit ?? 100);
    },
    getSystemFlag(key: string) {
      return flags.get(key) ?? null;
    },
    setSystemFlag(key: string, value: string) {
      flags.set(key, value);
    },
  };
}

function makeNotifier(): Notifier & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    isConfigured: () => true,
    send: async (text: string) => { messages.push(text); },
    escalation: async () => {},
    taskRejected: async () => {},
    notifyOperator: async () => true,
    supervisorDecision: async () => {},
    healthRecovery: async () => {},
    memoryDigest: async () => {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("classifyMisroutedTask", () => {
  it("returns 'implementation' for task_type=implementation", () => {
    const task = makeTask({ id: "1", task_type: "implementation", title: "Add auth endpoint" });
    expect(classifyMisroutedTask(task)).toBe("implementation");
  });

  it("returns 'cross-repo-followup' for implementation tasks with follow-up in title", () => {
    const task = makeTask({ id: "2", task_type: "implementation", title: "Cross-repo followup: update dashboard" });
    expect(classifyMisroutedTask(task)).toBe("cross-repo-followup");
  });

  it("returns 'cross-repo-followup' for follow-up pattern", () => {
    const task = makeTask({ id: "3", task_type: "implementation", title: "Follow-up: fix auth in proxy" });
    expect(classifyMisroutedTask(task)).toBe("cross-repo-followup");
  });

  it("returns null for research tasks", () => {
    const task = makeTask({ id: "4", task_type: "research", title: "Research auth patterns" });
    expect(classifyMisroutedTask(task)).toBeNull();
  });

  it("returns null for housekeeping tasks", () => {
    const task = makeTask({ id: "5", task_type: "housekeeping", title: "Triage open issues" });
    expect(classifyMisroutedTask(task)).toBeNull();
  });
});

describe("buildMisroutingDigest", () => {
  it("returns empty entries when no tasks are dispatched to reviewer", () => {
    const store = makeStore([]);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);
    expect(report.entries).toHaveLength(0);
    expect(report.lookback_hours).toBe(24);
  });

  it("detects implementation tasks dispatched to reviewer", () => {
    const now = new Date().toISOString();
    const tasks = [
      makeTask({
        id: "01TASK001",
        title: "Implement token tracking",
        task_type: "implementation",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/research-agent#112",
        created_at: now,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].task_title).toBe("Implement token tracking");
    expect(report.entries[0].dispatched_agent).toBe("claude-orchestrator-reviewer");
    expect(report.entries[0].suggested_agent).toBe("claude-research-agent");
    expect(report.entries[0].issue_link).toBe("rapartlu/research-agent#112");
    expect(report.entries[0].category).toBe("implementation");
  });

  it("excludes tasks older than lookback window", () => {
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString(); // 25 hours ago
    const tasks = [
      makeTask({
        id: "01OLDTASK",
        title: "Old implementation task",
        task_type: "implementation",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/agent-orchestrator#100",
        created_at: old,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);
    expect(report.entries).toHaveLength(0);
  });

  it("excludes non-implementation tasks", () => {
    const now = new Date().toISOString();
    const tasks = [
      makeTask({
        id: "01RESEARCH",
        title: "Research auth patterns",
        task_type: "research",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/agent-orchestrator#200",
        created_at: now,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);
    expect(report.entries).toHaveLength(0);
  });

  it("infers suggested agent from repo ownership", () => {
    const now = new Date().toISOString();
    const tasks = [
      makeTask({
        id: "01DASH",
        title: "Add bypass reason gate",
        task_type: "implementation",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/agent-dashboard#492",
        created_at: now,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].suggested_agent).toBe("claude-orchestrator-dashboard");
  });

  it("sets suggested_agent to null for unknown repos", () => {
    const now = new Date().toISOString();
    const tasks = [
      makeTask({
        id: "01UNKNOWN",
        title: "Fix something",
        task_type: "implementation",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/unknown-repo#1",
        created_at: now,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].suggested_agent).toBeNull();
  });

  it("detects cross-repo-followup category from title", () => {
    const now = new Date().toISOString();
    const tasks = [
      makeTask({
        id: "01XREPO",
        title: "Cross-repo followup: update CLAUDE.md in dashboard",
        task_type: "implementation",
        agent_name: "claude-orchestrator-reviewer",
        source_ref: "rapartlu/agent-dashboard#500",
        created_at: now,
      }),
    ];
    const store = makeStore(tasks);
    const config = makeConfig();
    const report = buildMisroutingDigest(store, config);

    expect(report.entries).toHaveLength(1);
    expect(report.entries[0].category).toBe("cross-repo-followup");
  });
});

describe("formatMisroutingDigest", () => {
  it("renders clean message when no misrouted tasks", () => {
    const report: MisroutingDigestReport = {
      generated_at: "2026-04-20T09:00:00.000Z",
      lookback_hours: 24,
      entries: [],
    };
    const msg = formatMisroutingDigest(report);
    expect(msg).toContain("Reviewer Misrouting Digest");
    expect(msg).toContain("No implementation tasks landed on the reviewer");
    expect(msg).toContain("Routing policies are working correctly");
  });

  it("renders entries with task details", () => {
    const report: MisroutingDigestReport = {
      generated_at: "2026-04-20T09:00:00.000Z",
      lookback_hours: 24,
      entries: [
        {
          task_id: "01KPKZZD12345678",
          task_title: "Implement token tracking",
          dispatched_agent: "claude-orchestrator-reviewer",
          suggested_agent: "claude-research-agent",
          issue_link: "rapartlu/research-agent#112",
          category: "implementation",
        },
        {
          task_id: "01KPKY7212345678",
          task_title: "Cross-repo followup: update dashboard config",
          dispatched_agent: "claude-orchestrator-reviewer",
          suggested_agent: "claude-orchestrator-dashboard",
          issue_link: "rapartlu/agent-dashboard#492",
          category: "cross-repo-followup",
        },
      ],
    };
    const msg = formatMisroutingDigest(report);

    expect(msg).toContain("2 implementation tasks dispatched to reviewer");
    expect(msg).toContain("01KPKZZD");
    expect(msg).toContain("claude-orchestrator-reviewer");
    expect(msg).toContain("claude-research-agent");
    expect(msg).toContain("rapartlu/research-agent#112");
    expect(msg).toContain("\\[impl\\]");
    expect(msg).toContain("\\[cross-repo\\]");
    expect(msg).toContain("Review dispatch policies");
  });

  it("handles entries without suggested agent", () => {
    const report: MisroutingDigestReport = {
      generated_at: "2026-04-20T09:00:00.000Z",
      lookback_hours: 24,
      entries: [
        {
          task_id: "01TASK00012345678",
          task_title: "Fix unknown repo thing",
          dispatched_agent: "claude-orchestrator-reviewer",
          suggested_agent: null,
          issue_link: null,
          category: "implementation",
        },
      ],
    };
    const msg = formatMisroutingDigest(report);

    expect(msg).toContain("1 implementation task dispatched");
    expect(msg).not.toContain("Suggested:");
  });
});

describe("MisroutingDigestScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires digest at configured hour", async () => {
    // Set time to 09:00 UTC
    vi.setSystemTime(new Date("2026-04-20T09:00:00.000Z"));

    const store = makeStore([]);
    const notifier = makeNotifier();
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config, { digestHourUtc: 9 });

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(true);
    expect(notifier.messages).toHaveLength(1);
    expect(notifier.messages[0]).toContain("Reviewer Misrouting Digest");
    expect(store.flags.get(FLAG_LAST_MISROUTING_DIGEST_SENT)).toBe("2026-04-20");
  });

  it("skips when not the configured hour", async () => {
    vi.setSystemTime(new Date("2026-04-20T14:00:00.000Z"));

    const store = makeStore([]);
    const notifier = makeNotifier();
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config, { digestHourUtc: 9 });

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(false);
    expect(notifier.messages).toHaveLength(0);
  });

  it("skips when already sent today", async () => {
    vi.setSystemTime(new Date("2026-04-20T09:30:00.000Z"));

    const store = makeStore([]);
    store.flags.set(FLAG_LAST_MISROUTING_DIGEST_SENT, "2026-04-20");
    const notifier = makeNotifier();
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config, { digestHourUtc: 9 });

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(false);
    expect(notifier.messages).toHaveLength(0);
  });

  it("sends again on a new day", async () => {
    vi.setSystemTime(new Date("2026-04-21T09:00:00.000Z"));

    const store = makeStore([]);
    store.flags.set(FLAG_LAST_MISROUTING_DIGEST_SENT, "2026-04-20");
    const notifier = makeNotifier();
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config, { digestHourUtc: 9 });

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(true);
    expect(store.flags.get(FLAG_LAST_MISROUTING_DIGEST_SENT)).toBe("2026-04-21");
  });

  it("defaults to hour 9 UTC", async () => {
    vi.setSystemTime(new Date("2026-04-20T09:00:00.000Z"));

    const store = makeStore([]);
    const notifier = makeNotifier();
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config);

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(true);
  });

  it("handles notifier errors gracefully", async () => {
    vi.setSystemTime(new Date("2026-04-20T09:00:00.000Z"));

    const store = makeStore([]);
    const notifier = makeNotifier();
    notifier.send = async () => { throw new Error("Telegram API down"); };
    const config = makeConfig();
    const scheduler = new MisroutingDigestScheduler(store, notifier, config);

    const sent = await scheduler.maybeFireDigest();
    expect(sent).toBe(false);
    // Should not mark as sent on failure
    expect(store.flags.has(FLAG_LAST_MISROUTING_DIGEST_SENT)).toBe(false);
  });
});
