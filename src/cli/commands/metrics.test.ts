import { describe, it, expect } from "vitest";
import {
  formatDuration,
  formatPct,
  formatScore,
  colorFailPct,
  colorRejectionPct,
  formatTrend,
} from "./metrics.js";

describe("metrics formatters", () => {
  describe("formatDuration", () => {
    it("returns em-dash for null", () => {
      const result = formatDuration(null);
      expect(result).toContain("—");
    });

    it("formats sub-minute durations in seconds", () => {
      const result = formatDuration(45000);
      expect(result).toBe("45s");
    });

    it("formats minute-range durations", () => {
      const result = formatDuration(154000); // 2m 34s
      expect(result).toBe("2m 34s");
    });

    it("formats hour-range durations", () => {
      const result = formatDuration(4320000); // 1h 12m
      expect(result).toBe("1h 12m");
    });

    it("rounds to nearest second", () => {
      const result = formatDuration(1500); // 1.5s → 2s
      expect(result).toBe("2s");
    });
  });

  describe("formatPct", () => {
    it("returns em-dash for null", () => {
      const result = formatPct(null);
      expect(result).toContain("—");
    });

    it("formats a percentage with rounding", () => {
      const result = formatPct(33.6);
      expect(result).toBe("34%");
    });

    it("formats zero", () => {
      const result = formatPct(0);
      expect(result).toBe("0%");
    });
  });

  describe("formatScore", () => {
    it("returns em-dash for null", () => {
      const result = formatScore(null);
      expect(result).toContain("—");
    });

    it("formats score to 2 decimal places", () => {
      // Strip ANSI codes from the formatted result
      const result = formatScore(0.876).replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("0.88");
    });

    it("formats low score", () => {
      const result = formatScore(0.4).replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("0.40");
    });
  });

  describe("colorFailPct", () => {
    it("returns em-dash for null", () => {
      const result = colorFailPct(null);
      expect(result).toContain("—");
    });

    it("returns a string with percentage", () => {
      const result = colorFailPct(15).replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("15%");
    });

    it("handles zero", () => {
      const result = colorFailPct(0).replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("0%");
    });
  });

  describe("colorRejectionPct", () => {
    it("returns em-dash for null", () => {
      const result = colorRejectionPct(null);
      expect(result).toContain("—");
    });

    it("formats rejection percentage", () => {
      const result = colorRejectionPct(25).replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("25%");
    });
  });

  describe("formatTrend", () => {
    it("formats improving trend", () => {
      const result = formatTrend("improving").replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("↑ improving");
    });

    it("formats declining trend", () => {
      const result = formatTrend("declining").replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("↓ declining");
    });

    it("formats stable trend", () => {
      const result = formatTrend("stable").replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("→ stable");
    });

    it("formats insufficient_data trend", () => {
      const result = formatTrend("insufficient_data").replace(/\x1b\[[0-9;]*m/g, "");
      expect(result).toBe("? n/a");
    });
  });
});
