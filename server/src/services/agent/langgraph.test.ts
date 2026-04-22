import { EventType } from "@ag-ui/core";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  eventsFromAIMessageStream,
  eventsFromToolMessage,
  toAIMessage,
} from "./langgraph.js";

async function collectEvents<T>(iterable: AsyncIterable<T>) {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

async function collectEventsWithReturn<T, R>(iterable: AsyncGenerator<T, R>) {
  const items: T[] = [];

  while (true) {
    const next = await iterable.next();
    if (next.done) {
      return { items, result: next.value };
    }

    items.push(next.value);
  }
}

async function* streamChunks(...chunks: AIMessageChunk[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("eventsFromAIMessageStream", () => {
  it("streams text chunks in order", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({ id: "msg-1", content: "Hel" }),
        new AIMessageChunk({ id: "msg-1", content: "lo" }),
        new AIMessageChunk({ id: "msg-1", content: " world" })
      )
    );

    const { items, result } = await collectEventsWithReturn(generator);

    expect(items.map((event) => event.type)).toEqual([
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

    expect(items.slice(1, 4).map((event) => (event as { delta?: string }).delta)).toEqual([
      "Hel",
      "lo",
      " world",
    ]);

    expect(result).toBeInstanceOf(AIMessageChunk);
    expect(toAIMessage(result!).content).toBe("Hello world");
  });

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
        })
      )
    );

    const { items } = await collectEventsWithReturn(generator);

    expect(items.map((event) => event.type)).toEqual([
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

    expect(items[1]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: '{"query":"hel',
    });

    expect(items[2]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-1",
      delta: 'lo"}',
    });
  });

  it("reuses one tool call id across chunk fragments that only share index", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({
          id: "msg-tool-index",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-index-1",
              index: 0,
              name: "confirm_action",
              args: '{"action":"deploy',
              type: "tool_call_chunk",
            },
          ],
        }),
        new AIMessageChunk({
          id: "msg-tool-index",
          content: "",
          tool_call_chunks: [
            {
              index: 0,
              args: ' production","severity":"high"}',
              type: "tool_call_chunk",
            },
          ],
          tool_calls: [
            {
              id: "tool-index-1",
              name: "confirm_action",
              args: { action: "deploy production", severity: "high" },
              type: "tool_call",
            },
          ],
        })
      )
    );

    const { items } = await collectEventsWithReturn(generator);

    expect(items.map((event) => event.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
    ]);

    expect(items[0]).toMatchObject({
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-index-1",
      toolCallName: "confirm_action",
    });

    expect(items[1]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-index-1",
      delta: '{"action":"deploy',
    });

    expect(items[2]).toMatchObject({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "tool-index-1",
      delta: ' production","severity":"high"}',
    });

    expect(items[3]).toMatchObject({
      type: EventType.TOOL_CALL_END,
      toolCallId: "tool-index-1",
    });
  });

  it("closes and reopens text events when text resumes after tool-call chunks", async () => {
    const generator = eventsFromAIMessageStream(
      streamChunks(
        new AIMessageChunk({ id: "msg-mixed", content: "I can help." }),
        new AIMessageChunk({
          id: "msg-mixed",
          content: "",
          tool_call_chunks: [
            {
              id: "tool-mixed-1",
              index: 0,
              name: "confirm_action",
              args: '{"action":"deploy"}',
              type: "tool_call_chunk",
            },
          ],
        }),
        new AIMessageChunk({ id: "msg-mixed", content: " Please confirm." })
      )
    );

    const { items } = await collectEventsWithReturn(generator);

    expect(items.map((event) => event.type)).toEqual([
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

    expect(items[0]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-mixed",
    });

    expect(items[5]).toMatchObject({
      type: EventType.TEXT_MESSAGE_START,
      messageId: "msg-mixed",
    });
  });
});

describe("eventsFromToolMessage", () => {
  it("emits tool result events", async () => {
    const events = await collectEvents(
      eventsFromToolMessage(
        new ToolMessage({
          id: "tool-msg-1",
          content: "42",
          tool_call_id: "tool-1",
        })
      )
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
});
