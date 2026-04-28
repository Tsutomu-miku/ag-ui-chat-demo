/**
 * Tests for schema key filtering.
 * Aligned with Python test_get_schema_keys.py.
 */

import { describe, expect, it } from "vitest";

import {
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
} from "../src/utils/convert.js";

describe("filterObjectBySchemaKeys", () => {
  it("filters object to only include specified keys", () => {
    const obj = { a: 1, b: 2, c: 3, d: 4 };
    expect(filterObjectBySchemaKeys(obj, ["a", "c"])).toEqual({ a: 1, c: 3 });
  });

  it("returns empty object for empty input", () => {
    expect(filterObjectBySchemaKeys({}, ["a"])).toEqual({});
  });

  it("returns empty object when no keys match", () => {
    expect(filterObjectBySchemaKeys({ a: 1 }, ["b", "c"])).toEqual({});
  });
});

describe("getStreamPayloadInput", () => {
  it("returns state for start mode", () => {
    const result = getStreamPayloadInput({
      mode: "start",
      state: { messages: [], tools: [] },
      schemaKeys: {},
    });
    expect(result).toEqual({ messages: [], tools: [] });
  });

  it("returns null for continue mode", () => {
    const result = getStreamPayloadInput({
      mode: "continue",
      state: { messages: [] },
      schemaKeys: {},
    });
    expect(result).toBeNull();
  });

  it("filters state by input schema keys", () => {
    const result = getStreamPayloadInput({
      mode: "start",
      state: {
        messages: ["msg"],
        tools: ["tool"],
        extra: "removed",
      },
      schemaKeys: { input: ["messages"] },
    });
    // Should include "messages" (from schema_keys.input) and "tools" (from DEFAULT_SCHEMA_KEYS)
    expect(result).toEqual({ messages: ["msg"], tools: ["tool"] });
  });
});
