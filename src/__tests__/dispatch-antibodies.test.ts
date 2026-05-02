import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StateStore } from "../state/store.js";
import { injectDispatchAntibodies } from "../triggers/dispatch-antibodies.js";
import { seedAntibodies, INITIAL_ANTIBODY_SEEDS } from "../triggers/seed-antibodies.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

describe("dispatch-antibodies", () => {
  let store: StateStore;
  let dbPath: string;

  beforeEach(() => {
    // Create a temp directory for the test database
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "antibody-test-"));
    dbPath = path.join(tmpDir, "test-state.db");
    store = new StateStore(dbPath);
  });

  afterEach(() => {
    store.close();
    // Clean up temp files
    try {
      fs.unlinkSync(dbPath);
      fs.rmdirSync(path.dirname(dbPath));
    } catch {
      // ignore cleanup errors
    }
  });

  describe("seedAntibodies", () => {
    it("seeds initial antibodies into the signals table", () => {
      const result = seedAntibodies(store);
      expect(result.seeded).toBe(INITIAL_ANTIBODY_SEEDS.length);
      expect(result.skipped).toBe(0);

      // Verify signals are in the database
      const signals = store.readSignals({ limit: 100 });
      expect(signals.length).toBe(INITIAL_ANTIBODY_SEEDS.length);
    });

    it("is idempotent — does not duplicate seeds", () => {
      const first = seedAntibodies(store);
      expect(first.seeded).toBe(INITIAL_ANTIBODY_SEEDS.length);

      const second = seedAntibodies(store);
      expect(second.seeded).toBe(0);
      expect(second.skipped).toBe(INITIAL_ANTIBODY_SEEDS.length);

      // Still only original count in database
      const signals = store.readSignals({ limit: 100 });
      expect(signals.length).toBe(INITIAL_ANTIBODY_SEEDS.length);
    });
  });

  describe("injectDispatchAntibodies", () => {
    it("returns original message when no signals exist", () => {
      const original = "GitHub Issue #42: Fix the widget";
      const result = injectDispatchAntibodies(store, original, {
        repo: "rapartlu/agent-orchestrator",
        agentName: "test-agent",
        issueNumber: 42,
        sourceRef: "rapartlu/agent-orchestrator#42",
      });

      expect(result.injected).toBe(false);
      expect(result.count).toBe(0);
      expect(result.message).toBe(original);
    });

    it("injects antibody hints when matching signals exist", () => {
      // Seed antibodies first
      seedAntibodies(store);

      const original = "GitHub Issue #42: Fix the widget";
      const result = injectDispatchAntibodies(store, original, {
        repo: "rapartlu/agent-orchestrator",
        agentName: "test-agent",
        issueNumber: 42,
        sourceRef: "rapartlu/agent-orchestrator#42",
      });

      expect(result.injected).toBe(true);
      expect(result.count).toBeGreaterThan(0);
      expect(result.message).toContain("Fleet Antibodies");
      expect(result.message).toContain(original); // original message preserved
      expect(result.signalIds.length).toBeGreaterThan(0);
    });

    it("limits the number of injected hints", () => {
      // Write 10 signals
      for (let i = 0; i < 10; i++) {
        store.writeSignal({
          agent: "seeder",
          signal_type: "failure_antibody",
          key: `test-hint-${i}`,
          value: { fix_hint: `Fix hint number ${i}` },
          confidence: 0.8,
          ttl_hours: 720,
        });
      }

      const result = injectDispatchAntibodies(store, "test message", {
        repo: "rapartlu/agent-orchestrator",
        agentName: "test-agent",
        issueNumber: 1,
        sourceRef: "rapartlu/agent-orchestrator#1",
      });

      // Should be capped at MAX_ANTIBODY_HINTS (5)
      expect(result.count).toBeLessThanOrEqual(5);
    });

    it("filters out low-confidence signals", () => {
      store.writeSignal({
        agent: "seeder",
        signal_type: "failure_antibody",
        key: "low-confidence-hint",
        value: { fix_hint: "This should not be injected" },
        confidence: 0.1, // Below MIN_SIGNAL_CONFIDENCE (0.3)
        ttl_hours: 720,
      });

      const result = injectDispatchAntibodies(store, "test message", {
        repo: "rapartlu/agent-orchestrator",
        agentName: "test-agent",
        issueNumber: 1,
        sourceRef: "rapartlu/agent-orchestrator#1",
      });

      expect(result.injected).toBe(false);
      expect(result.count).toBe(0);
    });

    it("records signal reads for consumption tracking", () => {
      store.writeSignal({
        agent: "seeder",
        signal_type: "failure_antibody",
        key: "tracked-hint",
        value: { fix_hint: "This should be tracked" },
        confidence: 0.8,
        ttl_hours: 720,
      });

      injectDispatchAntibodies(store, "test message", {
        repo: "rapartlu/agent-orchestrator",
        agentName: "consuming-agent",
        issueNumber: 1,
        sourceRef: "rapartlu/agent-orchestrator#1",
      });

      // Check that the signal activity feed shows the read event
      const feed = store.getSignalActivityFeed(10);
      const readEvents = feed.filter((e) => e.event_type === "read");
      expect(readEvents.length).toBeGreaterThan(0);
      expect(readEvents[0].agent).toBe("consuming-agent");
    });
  });
});
