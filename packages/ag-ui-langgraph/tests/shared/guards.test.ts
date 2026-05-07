import { describe, expect, it } from "vitest";

import {
  arrayValue,
  isRecord,
  recordValue,
  stringValue,
} from "../../src/shared/guards.js";

describe("shared guards", () => {
  it("reads common record shapes safely", () => {
    const value = { name: "demo", items: [1, 2], count: 2 };

    expect(isRecord(value)).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(recordValue(value, "count")).toBe(2);
    expect(stringValue(value, "name")).toBe("demo");
    expect(stringValue(value, "count")).toBeUndefined();
    expect(arrayValue(value, "items")).toEqual([1, 2]);
    expect(arrayValue(value, "missing")).toEqual([]);
  });
});
