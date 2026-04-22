import { describe, expect, it } from "vitest";

import type { ChatMessage } from "../types";
import { updateMessagesWithAgentEvent } from "./useThreads";

describe("updateMessagesWithAgentEvent", () => {
  it("folds assistant text streaming into a single message", () => {
    let messages: ChatMessage[] = [];

    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_start",
      messageId: "assistant-1",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_delta",
      messageId: "assistant-1",
      delta: "Hel",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_delta",
      messageId: "assistant-1",
      delta: "lo",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_end",
      messageId: "assistant-1",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
      isStreaming: false,
    });
  });

  it("keeps tool call lifecycle on the same assistant message", () => {
    let messages: ChatMessage[] = [];

    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_start",
      messageId: "assistant-2",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_delta",
      messageId: "assistant-2",
      delta: "Please confirm.",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "assistant_end",
      messageId: "assistant-2",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_start",
      parentMessageId: "assistant-2",
      toolCallId: "tool-2",
      toolCallName: "confirm_action",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_args",
      toolCallId: "tool-2",
      delta: '{"action":"deploy","severity":"high"}',
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_end",
      toolCallId: "tool-2",
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "assistant-2",
      content: "Please confirm.",
      toolCalls: [
        {
          id: "tool-2",
          type: "function",
          function: {
            name: "confirm_action",
            arguments: '{"action":"deploy","severity":"high"}',
          },
          complete: true,
        },
      ],
      isStreaming: false,
    });
  });

  it("appends tool call argument deltas", () => {
    let messages: ChatMessage[] = [];

    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_start",
      parentMessageId: "assistant-args",
      toolCallId: "tool-args",
      toolCallName: "search_web",
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_args",
      toolCallId: "tool-args",
      delta: '{"query":"hel',
    });
    messages = updateMessagesWithAgentEvent(messages, {
      type: "tool_args",
      toolCallId: "tool-args",
      delta: 'lo"}',
    });

    expect(messages[0].toolCalls?.[0].function.arguments).toBe(
      '{"query":"hello"}',
    );
  });

  it("stores step metadata on assistant messages and tool calls", () => {
    const updated = updateMessagesWithAgentEvent([], {
      type: "tool_start",
      parentMessageId: "assistant-step",
      toolCallId: "tool-step",
      toolCallName: "search_web",
      stepName: "researcher",
      parentStepName: "supervisor",
    });

    expect(updated[0]).toMatchObject({
      id: "assistant-step",
      stepName: "researcher",
      parentStepName: "supervisor",
      toolCalls: [
        {
          id: "tool-step",
          stepName: "researcher",
          parentStepName: "supervisor",
        },
      ],
    });
  });

  it("reuses an existing assistant message when tool calls start after text end", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-3",
        role: "assistant",
        content: "Ready.",
        isStreaming: false,
        createdAt: new Date().toISOString(),
      },
    ];

    const updated = updateMessagesWithAgentEvent(messages, {
      type: "tool_start",
      parentMessageId: "assistant-3",
      toolCallId: "tool-3",
      toolCallName: "search_web",
    });

    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      id: "assistant-3",
      content: "Ready.",
      toolCalls: [
        {
          id: "tool-3",
          function: {
            name: "search_web",
            arguments: "",
          },
          complete: false,
        },
      ],
    });
  });

  it("appends tool result messages without replacing existing thread messages", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-4",
        role: "assistant",
        content: "Waiting for confirmation.",
        toolCalls: [
          {
            id: "tool-4",
            type: "function",
            function: {
              name: "confirm_action",
              arguments: '{"action":"deploy"}',
            },
            complete: false,
          },
        ],
        createdAt: new Date().toISOString(),
      },
    ];

    const updated = updateMessagesWithAgentEvent(messages, {
      type: "append_message",
      message: {
        id: "tool-message-4",
        role: "tool",
        content: '{"approved":true}',
        toolCallId: "tool-4",
        createdAt: new Date().toISOString(),
      },
    });

    expect(updated).toHaveLength(2);
    expect(updated[0].id).toBe("assistant-4");
    expect(updated[1]).toMatchObject({
      id: "tool-message-4",
      role: "tool",
      content: '{"approved":true}',
      toolCallId: "tool-4",
    });
    expect(updated[0].toolCalls?.[0].complete).toBe(true);
  });

  it("keeps tool call output available in the same local message tree", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-5",
        role: "assistant",
        content: "Calculating...",
        toolCalls: [
          {
            id: "tool-5",
            type: "function",
            function: {
              name: "calculate",
              arguments: '{"expression":"12*3"}',
            },
            complete: true,
          },
        ],
        isStreaming: true,
        createdAt: new Date().toISOString(),
      },
    ];

    const updated = updateMessagesWithAgentEvent(messages, {
      type: "append_message",
      message: {
        id: "tool-message-5",
        role: "tool",
        content: "36",
        toolCallId: "tool-5",
        createdAt: new Date().toISOString(),
      },
    });

    expect(updated).toHaveLength(2);
    expect(updated[0].toolCalls?.[0]).toMatchObject({
      id: "tool-5",
      complete: true,
      function: {
        name: "calculate",
        arguments: '{"expression":"12*3"}',
      },
    });
    expect(updated[1]).toMatchObject({
      id: "tool-message-5",
      role: "tool",
      content: "36",
      toolCallId: "tool-5",
    });
  });

  it("clears streaming markers when a run completes", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-6",
        role: "assistant",
        content: "Working...",
        isStreaming: true,
        createdAt: new Date().toISOString(),
      },
    ];

    const updated = updateMessagesWithAgentEvent(messages, {
      type: "run_complete",
    });

    expect(updated[0]).toMatchObject({
      id: "assistant-6",
      isStreaming: false,
    });
  });
});
