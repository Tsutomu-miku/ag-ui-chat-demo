import { EventType, type Message } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { persistHistory } from "./persistence.js";
import { getThread } from "./store.js";

describe("persistHistory", () => {
  it("merges text chunks into one assistant message", () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    const inputMessages: Message[] = [
      {
        id: `user-${crypto.randomUUID()}`,
        role: "user",
        content: "hello",
      },
    ];

    persistHistory(threadId, inputMessages, [
      { type: EventType.RUN_STARTED, threadId, runId: "run-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "assistant-1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "assistant-1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-1" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[1]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
    });
  });

  it("stores tool call args and tool result", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-2" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-2", role: "assistant" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-2",
        toolCallId: "tool-2",
        toolCallName: "calculator",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-2", delta: '{"expression":"2+' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-2", delta: '2"}' },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-2" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-message-2",
        toolCallId: "tool-2",
        content: "4",
        role: "tool",
      },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-2" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-2",
      role: "assistant",
      toolCalls: [
        {
          id: "tool-2",
          type: "function",
          function: {
            name: "calculator",
            arguments: '{"expression":"2+2"}',
          },
        },
      ],
    });
    expect(thread?.messages[1]).toMatchObject({
      id: "tool-message-2",
      role: "tool",
      toolCallId: "tool-2",
      content: "4",
    });
  });

  it("keeps tool calls on the same assistant message when tool events arrive after text end", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-3" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-3", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-3", delta: "Please confirm." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-3" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-3",
        toolCallId: "tool-3",
        toolCallName: "confirm_action",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-3",
        delta: '{"action":"Deploy production","severity":"high"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "tool-3" },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-3" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-3",
      role: "assistant",
      content: "Please confirm.",
      toolCalls: [
        {
          id: "tool-3",
          type: "function",
          function: {
            name: "confirm_action",
            arguments: '{"action":"Deploy production","severity":"high"}',
          },
        },
      ],
    });
  });
});
