import { describe, it, expect } from "vitest";
import { extractJSON, extractAndValidate } from "./json-extract.js";

describe("extractJSON", () => {
  it("parses clean JSON", () => {
    expect(extractJSON('{"a": 1}')).toEqual({ a: 1 });
  });

  it("strips code fences", () => {
    expect(extractJSON('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("strips code fences without language tag", () => {
    expect(extractJSON('```\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it("extracts JSON wrapped in explanation text", () => {
    const text = 'Here is my analysis:\n\n{"score": 0.8, "approved": true}\n\nThe code looks good.';
    expect(extractJSON(text, "score")).toEqual({ score: 0.8, approved: true });
  });

  it("extracts JSON from code fences with surrounding text", () => {
    const text = 'Based on review:\n```json\n{"decision": "approve"}\n```\nDone.';
    expect(extractJSON(text, "decision")).toEqual({ decision: "approve" });
  });

  it("extracts JSON array", () => {
    const text = 'Found improvements:\n[{"title": "Fix A"}, {"title": "Fix B"}]';
    const result = extractJSON(text);
    expect(result).toEqual([{ title: "Fix A" }, { title: "Fix B" }]);
  });

  it("returns null for completely unparseable text", () => {
    expect(extractJSON("This is just plain text with no JSON at all.")).toBeNull();
  });

  it("handles nested JSON objects", () => {
    const text = '{"outer": {"inner": 42}, "key": "value"}';
    expect(extractJSON(text)).toEqual({ outer: { inner: 42 }, key: "value" });
  });
});

describe("extractAndValidate", () => {
  it("returns object when all required fields present", () => {
    const result = extractAndValidate('{"score": 0.8, "approved": true}', ["score", "approved"]);
    expect(result).toEqual({ score: 0.8, approved: true });
  });

  it("returns null when required field is missing", () => {
    const result = extractAndValidate('{"score": 0.8}', ["score", "approved"]);
    expect(result).toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(extractAndValidate("no json here", ["score"])).toBeNull();
  });
});
