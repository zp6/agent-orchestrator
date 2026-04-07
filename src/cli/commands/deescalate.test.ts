import { describe, it, expect } from "vitest";
import { normaliseSourceRef } from "./deescalate.js";

describe("normaliseSourceRef", () => {
  it("passes through a plain owner/repo#N ref unchanged", () => {
    expect(normaliseSourceRef("rapartlu/agent-proxy#145")).toBe(
      "rapartlu/agent-proxy#145",
    );
  });

  it("strips a 'github:' prefix", () => {
    expect(normaliseSourceRef("github:rapartlu/agent-proxy#145")).toBe(
      "rapartlu/agent-proxy#145",
    );
  });

  it("strips a 'pr-feedback:' prefix", () => {
    expect(normaliseSourceRef("pr-feedback:rapartlu/agent-proxy#145")).toBe(
      "rapartlu/agent-proxy#145",
    );
  });

  it("handles a ref with no prefix and no slash (issue number only)", () => {
    expect(normaliseSourceRef("#42")).toBe("#42");
  });

  it("handles a bare repo#N ref", () => {
    expect(normaliseSourceRef("repo#42")).toBe("repo#42");
  });

  it("leaves non-whitelisted colon-prefixed refs intact", () => {
    expect(normaliseSourceRef("health-check-fail:agent-a")).toBe("health-check-fail:agent-a");
  });
});
