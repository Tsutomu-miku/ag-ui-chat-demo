/**
 * Tests for stream.ts — AI message stream to AG-UI event conversion.
 * Mirrors the existing langgraph.test.ts but targeting the extracted package.
 */

import { EventType } from "@ag-ui/core";
import { AIMessageChunk } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import { eventsFromAIMessageStream, withStreamEventMetadata } from "../src/stream.js";
import { toAIMessage } from "../src/tools.js";

// ── Test helpers ──

async function collectEventsWithReturn<T, R>(
  iterable: AsyncGenerator<T, R>,
) {
  const items: T[] = [];
  while (true) {
    const next = await iterable.next();
    if (next.done) return { items, result: next.value };
    items.push(next.value);
  }
}

async function* streamChunks(...chunks: AIMessageChunk[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ============================================================
// withStreamEventMetadata
// ============================================================

describe("withStreamEventMetadata", () => {
  it("returns event unchanged when metadata is empty", () => {
    const event = { type: EventType.RUN_STARTED } as any;
    const result = withStreamEventMetadata(event, {});
    expect(result).toBe(event); // same reference
  });

  it("merges metadata into event", () => {
    const event = { type: EventType.STEP_STARTED, stepName: "test" } as any;
    const result = withStreamEventMetadata(event, {
      stepName: "sub-agent",
      parentStepName: "supervisor",
    });
    expect(result.stepName).toBe("sub-agent");
    expect(result.parentStepName).toBe("supervisor");
  });

  it("skips undefined metadata values", () => {
    const event = { type: EventType.RUN_STARTED } as any;
    const result = withStreamEventMetadata(event, {
      stepName: "test",
      parentStepName: undefined,
    });
    expect(result.stepName).toBe("test");
    expect(result).not.toHaveProperty("parentStepName");
  });
});

// ============================================================
// eventsFromAIMessageStream — text streaming
// ============================================================

describe("eventsFromAIMessageStream", () => {
  it("streams text chunks in order", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({ id: "msg-1", content: "Hel" }),
        new AIMessageChunk({ id: "msg-1", content: "lo" }),
        new AIMessageChunk({ id: "msg-1", content: " world" }),
      ),
    );

    const { items, result } = await collectEventsWithReturn(generator);

    expect(items.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
    ]);

    expect(items[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-1",
      role: "assistant",
    });

    expect(
      items.slice(1, 4).map((e) => (e as { delta?: string }).delta),
    ).toEqual(["Hel", "lo", " world"]);

    expect(result).toBeInstanceOf(AIMessageChunk);
    expect(toAIMessage(result!).content).toBe("Hello world");
  });

  it("returns undefined for empty stream", async () => {
    const generator = eventsFromAIMessageStream(streamChunks());
    const { items, result } = await collectEventsWithReturn(generator);
    expect(items).toEqual([]);
    expect(result).toBeUndefined();
  });

  // ── Tool call streaming ──

  it("emits tool call lifecycle events with accumulated args", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({
          id: "msg-tool",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-1",
              index: 0,
              name: "search_web",
              args: '{"query":"hel',
              type: "tool_call_chunk",
            },
          ],
        }),
        new AIMessageChunk({
          id: "msg-tool",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-1",
              index: 0,
              args: 'lo"}',
              type: "tool_call_chunk",
            },
          ],
          tool_calls: [
            {
              id: "tool-1",
              name: "search_web",
              args: { query: "hello" },
              type: "tool_call",
            },
          ],
        }),
      ),
    );

    const { items } = await collectEventsWithReturn(generator);

    expect(items.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);

    expect(items[0]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      parentMessageId: "msg-tool",
      toolCallId: "tool-1",
      toolCallName: "search_web",
    });
  });

  it("reuses tool call id across chunk fragments sharing index", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({
          id: "msg-idx",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-idx-1",
              index: 0,
              name: "confirm_action",
              args: '{"action":"deploy',
              type: "tool_call_chunk",
            },
          ],
        }),
        new AIMessageChunk({
          id: "msg-idx",
          content: "",
          tool_call_chunks: [
            {
              index: 0,
              args: '"}',
              type: "tool_call_chunk",
            },
          ],
          tool_calls: [
            {
              id: "tool-idx-1",
              name: "confirm_action",
              args: { action: "deploy" },
              type: "tool_call",
            },
          ],
        }),
      ),
    );

    const { items } = await collectEventsWithReturn(generator);

    expect(items[0]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-idx-1",
    });
    expect(items[items.length - 1]).toMatchObject({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-idx-1",
    });
  });

  // ── Text + tool interleaving ──

  it("closes and reopens text when tool calls interrupt", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({ id: "msg-mixed", content: "I can help." }),
        new AIMessageChunk({
          id: "msg-mixed",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-mx",
              index: 0,
              name: "confirm_action",
              args: '{"action":"deploy"}',
              type: "tool_call_chunk",
            },
          ],
        }),
        new AIMessageChunk({
          id: "msg-mixed",
          content: " Please confirm.",
        }),
      ),
    );

    const { items } = await collectEventsWithReturn(generator);
    const types = items.map((e) => e.type);

    expect(types).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TOOL_CALL_END,
      EventType.TEXT_MESSAGE_END,
    ]);
  });

  // ── Metadata propagation ──

  it("attaches metadata to all emitted events", async () => {
    const metadata = { stepName: "researcher", parentStepName: "supervisor" };
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({ id: "msg-meta", content: "Hello" }),
      ),
      metadata,
    );

    const { items } = await collectEventsWithReturn(generator);

    for (const event of items) {
      expect((event as any).stepName).toBe("researcher");
      expect((event as any).parentStepName).toBe("supervisor");
    }
  });
});
