/**
 * Tests for tools.ts — tool event helpers.
 */

import { EventType } from "@ag-ui/core";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { eventsFromToolMessage, toAIMessage } from "../src/tools.js";

// ── Test helpers ──

async function collectEvents<T>(iterable: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

// ============================================================
// eventsFromToolMessage
// ============================================================

describe("eventsFromToolMessage", () => {
  it("emits TOOL_CALL_RESULT event", async () => {
    const events = await collectEvents(
      eventsFromToolMessage(
        new ToolMessage({
          id: "tool-msg-1",
          content: "42",
          tool_call_id: "tool-1",
        }),
      ),
    );

    expect(events).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-msg-1",
        toolCallId: "tool-1",
        content: "42",
        role: "tool",
      },
    ]);
  });

  it("skips when tool_call_id is missing", async () => {
    const events = await collectEvents(
      eventsFromToolMessage(
        new ToolMessage({
          id: "tool-msg-2",
          content: "result",
          tool_call_id: "",
        }),
      ),
    );
    expect(events).toEqual([]);
  });

  it("attaches metadata when provided", async () => {
    const events = await collectEvents(
      eventsFromToolMessage(
        new ToolMessage({
          id: "tool-msg-3",
          content: "data",
          tool_call_id: "tc-3",
        }),
        { stepName: "researcher", parentStepName: "supervisor" },
      ),
    );

    expect(events[0]).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      stepName: "researcher",
      parentStepName: "supervisor",
    });
  });
});

// ============================================================
// toAIMessage
// ============================================================

describe("toAIMessage", () => {
  it("converts AIMessageChunk to AIMessage with text content", () => {
    const chunk = new AIMessageChunk({ id: "c1", content: "Hello world" });
    const msg = toAIMessage(chunk);

    expect(msg.id).toBe("c1");
    expect(msg.content).toBe("Hello world");
    expect(msg.tool_calls).toEqual([]);
  });

  it("preserves tool calls", () => {
    const chunk = new AIMessageChunk({
      id: "c2",
      content: "",
      tool_calls: [
        { id: "tc1", name: "calc", args: { expr: "1+1" }, type: "tool_call" },
      ],
    });
    const msg = toAIMessage(chunk);

    expect(msg.tool_calls).toMatchObject([
      { id: "tc1", name: "calc", args: { expr: "1+1" } },
    ]);
  });

  it("handles structured content by converting to string", () => {
    const chunk = new AIMessageChunk({
      id: "c3",
      content: [{ type: "text", text: "structured" }],
    });
    const msg = toAIMessage(chunk);
    expect(msg.content).toBe("structured");
  });
});
