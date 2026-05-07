import { EventType } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import {
  collectInterrupts,
  dumpJsonSafe,
  getStreamArgs,
  parseResumeInput,
  sanitizeRawPayloads,
} from "../../src/runtime/stream.js";

describe("event utility helpers", () => {
  it("sanitizes raw event payloads in place", () => {
    const raw: Record<string, unknown> = { type: "raw" };
    raw.self = raw;
    const event = {
      type: EventType.RAW,
      event: raw,
      rawEvent: new Map([["created", new Date("2026-01-01T00:00:00.000Z")]]),
    };

    expect(sanitizeRawPayloads(event as never)).toEqual({
      type: EventType.RAW,
      event: { type: "raw", self: "<recursive>" },
      rawEvent: { created: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("preserves non-raw events without raw payloads", () => {
    const event = { type: EventType.RUN_STARTED, runId: "r1", threadId: "t1" };
    expect(sanitizeRawPayloads(event as never)).toBe(event);
  });

  it("normalizes interrupt and resume payloads", () => {
    expect(
      collectInterrupts([
        { interrupts: [{ value: "a" }] },
        { interrupts: null },
        {},
      ]),
    ).toEqual([{ value: "a" }]);
    expect(collectInterrupts(null)).toEqual([]);
    expect(parseResumeInput('{"ok":true}')).toEqual({ ok: true });
    expect(parseResumeInput("plain")).toBe("plain");
    expect(parseResumeInput(undefined)).toBeNull();
  });

  it("builds stream args with defaults and context", () => {
    expect(getStreamArgs({ input: { messages: [] } })).toEqual({
      input: { messages: [] },
      options: {
        version: "v2",
        subgraphs: false,
      },
    });

    expect(
      getStreamArgs({
        input: null,
        config: {
          configurable: { thread_id: "t1" },
          tags: ["demo"],
        },
        version: "v1",
        subgraphs: true,
        context: { request_id: "r1" },
      }),
    ).toEqual({
      input: null,
      options: {
        configurable: { thread_id: "t1" },
        tags: ["demo"],
        version: "v1",
        subgraphs: true,
        context: {
          thread_id: "t1",
          request_id: "r1",
        },
      },
    });
  });

  it("falls back to object traversal when toJSON throws", () => {
    const value = {
      toJSON() {
        throw new Error("broken");
      },
    };
    expect(dumpJsonSafe(value)).toEqual({
      toJSON: expect.stringContaining("throw new Error"),
    });
  });
});
