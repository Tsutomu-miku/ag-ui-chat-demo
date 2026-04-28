/**
 * Tests for makeJsonSafe / jsonSafeStringify.
 * Aligned with Python test_make_json_safe.py.
 */

import { describe, expect, it } from "vitest";

import { makeJsonSafe, jsonSafeStringify } from "../src/utils/convert.js";

describe("makeJsonSafe", () => {
  // ── Primitives ──

  it("passes through null", () => {
    expect(makeJsonSafe(null)).toBeNull();
  });

  it("passes through undefined", () => {
    expect(makeJsonSafe(undefined)).toBeUndefined();
  });

  it("passes through strings", () => {
    expect(makeJsonSafe("hello")).toBe("hello");
  });

  it("passes through numbers", () => {
    expect(makeJsonSafe(42)).toBe(42);
    expect(makeJsonSafe(3.14)).toBe(3.14);
  });

  it("passes through booleans", () => {
    expect(makeJsonSafe(true)).toBe(true);
    expect(makeJsonSafe(false)).toBe(false);
  });

  // ── Dates ──

  it("converts Date to ISO string", () => {
    const d = new Date("2024-01-15T10:30:00.000Z");
    expect(makeJsonSafe(d)).toBe("2024-01-15T10:30:00.000Z");
  });

  // ── Arrays ──

  it("recursively processes arrays", () => {
    expect(makeJsonSafe([1, "two", { three: 3 }])).toEqual([
      1,
      "two",
      { three: 3 },
    ]);
  });

  it("handles nested arrays", () => {
    expect(makeJsonSafe([[1, 2], [3, [4]]])).toEqual([[1, 2], [3, [4]]]);
  });

  // ── Sets ──

  it("converts Sets to arrays", () => {
    const result = makeJsonSafe(new Set([1, 2, 3]));
    expect(result).toEqual([1, 2, 3]);
  });

  // ── Maps ──

  it("converts Maps to objects", () => {
    const m = new Map<string, number>([
      ["a", 1],
      ["b", 2],
    ]);
    expect(makeJsonSafe(m)).toEqual({ a: 1, b: 2 });
  });

  // ── Objects ──

  it("recursively processes objects", () => {
    expect(makeJsonSafe({ a: 1, b: { c: "d" } })).toEqual({
      a: 1,
      b: { c: "d" },
    });
  });

  it("skips 'runtime' and 'config' keys", () => {
    expect(
      makeJsonSafe({
        name: "test",
        runtime: { internal: true },
        config: { secret: "abc" },
        value: 42,
      }),
    ).toEqual({ name: "test", value: 42 });
  });

  // ── toJSON support ──

  it("uses toJSON() when available", () => {
    const obj = {
      data: "value",
      toJSON() {
        return { serialized: true };
      },
    };
    expect(makeJsonSafe(obj)).toEqual({ serialized: true });
  });

  // ── Cycle detection ──

  it("detects circular references", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = makeJsonSafe(obj) as Record<string, unknown>;
    expect(result.a).toBe(1);
    expect(result.self).toBe("<recursive>");
  });

  it("detects circular references in arrays", () => {
    const arr: unknown[] = [1, 2];
    arr.push(arr);
    const result = makeJsonSafe(arr) as unknown[];
    expect(result[0]).toBe(1);
    expect(result[1]).toBe(2);
    expect(result[2]).toBe("<recursive>");
  });

  // ── Mixed complex structures ──

  it("handles deeply nested structures", () => {
    const input = {
      level1: {
        level2: {
          level3: {
            value: "deep",
            date: new Date("2024-01-01T00:00:00.000Z"),
          },
        },
      },
    };
    const result = makeJsonSafe(input) as Record<string, unknown>;
    expect(
      ((result.level1 as Record<string, unknown>).level2 as Record<string, unknown>)
        .level3,
    ).toEqual({
      value: "deep",
      date: "2024-01-01T00:00:00.000Z",
    });
  });

  // ── Fallback ──

  it("converts functions to string representation", () => {
    const fn = () => {};
    const result = makeJsonSafe(fn);
    expect(typeof result).toBe("string");
  });

  it("converts symbols to string representation", () => {
    const result = makeJsonSafe(Symbol("test"));
    expect(typeof result).toBe("string");
    expect(result).toContain("test");
  });
});

// ============================================================
// jsonSafeStringify
// ============================================================

describe("jsonSafeStringify", () => {
  it("stringifies simple values", () => {
    expect(jsonSafeStringify({ a: 1 })).toBe('{"a":1}');
  });

  it("handles Date values in nested objects", () => {
    const result = jsonSafeStringify({
      created: new Date("2024-01-15T10:00:00.000Z"),
    });
    expect(result).toContain("2024-01-15");
  });

  it("produces valid JSON for complex structures", () => {
    const input = {
      name: "test",
      items: [1, "two", { three: 3 }],
      nested: { deep: true },
    };
    const result = jsonSafeStringify(input);
    expect(() => JSON.parse(result)).not.toThrow();
  });
});
