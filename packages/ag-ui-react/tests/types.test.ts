/**
 * Type-level tests for ag-ui-react types.
 *
 * These are compile-time checks ensuring the type exports are correct
 * and the discriminated union works properly.
 */

import { describe, expect, it } from "vitest";

import type {
  ToolCallFunction,
  ChatMessage,
  ChatThread,
  ThreadSummary,
  FrontendToolDefinition,
  PendingToolCall,
  ActiveStep,
  ThreadAgentEvent,
} from "../src/types.js";

describe("types", () => {
  it("ChatMessage roles include all expected values", () => {
    const user: ChatMessage = {
      id: "1",
      role: "user",
      content: "hello",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const assistant: ChatMessage = {
      id: "2",
      role: "assistant",
      content: "hi",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const tool: ChatMessage = {
      id: "3",
      role: "tool",
      content: "result",
      toolCallId: "tc1",
      createdAt: "2024-01-01T00:00:00.000Z",
    };
    const system: ChatMessage = {
      id: "4",
      role: "system",
      content: "system prompt",
      createdAt: "2024-01-01T00:00:00.000Z",
    };

    expect(user.role).toBe("user");
    expect(assistant.role).toBe("assistant");
    expect(tool.role).toBe("tool");
    expect(system.role).toBe("system");
  });

  it("ToolCallFunction has correct shape", () => {
    const tc: ToolCallFunction = {
      id: "tc1",
      type: "function",
      function: { name: "search", arguments: '{"q":"test"}' },
      complete: true,
      step: {
        id: "step-1",
        parentId: "step-root",
        kind: "subagent",
        name: "researcher",
      },
      extra: {
        visualization: {
          owner: {
            key: "researcher:one",
            type: "researcher",
            instanceId: "one",
            parentKey: "supervisor:root",
          },
        },
      },
    };

    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("search");
    expect(tc.step?.name).toBe("researcher");
  });

  it("ChatThread has messages array", () => {
    const thread: ChatThread = {
      id: "t1",
      title: "Test",
      messages: [],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    expect(thread.messages).toEqual([]);
  });

  it("ThreadSummary includes preview", () => {
    const summary: ThreadSummary = {
      id: "t1",
      title: "Test",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      messageCount: 5,
      preview: "Hello...",
    };

    expect(summary.messageCount).toBe(5);
  });

  it("FrontendToolDefinition has JSON Schema parameters", () => {
    const tool: FrontendToolDefinition = {
      name: "confirm_action",
      description: "Confirm an action",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
        },
      },
    };

    expect(tool.name).toBe("confirm_action");
  });

  it("PendingToolCall tracks status", () => {
    const pending: PendingToolCall = {
      toolCallId: "tc1",
      toolCallName: "confirm",
      args: { action: "deploy" },
      status: "pending",
    };

    const approved: PendingToolCall = { ...pending, status: "approved" };
    const rejected: PendingToolCall = { ...pending, status: "rejected" };

    expect(pending.status).toBe("pending");
    expect(approved.status).toBe("approved");
    expect(rejected.status).toBe("rejected");
  });

  it("ActiveStep has required and optional fields", () => {
    const root: ActiveStep = {
      stepName: "supervisor",
      step: {
        id: "step-root",
        kind: "agent",
        name: "supervisor",
      },
      startedAt: "2024-01-01T00:00:00.000Z",
    };
    const child: ActiveStep = {
      stepName: "researcher",
      step: {
        id: "step-child",
        parentId: "step-root",
        kind: "subagent",
        name: "researcher",
      },
      startedAt: "2024-01-01T00:00:00.000Z",
    };

    expect(root.step?.parentId).toBeUndefined();
    expect(child.step?.parentId).toBe("step-root");
  });

  it("ThreadAgentEvent discriminated union covers all event types", () => {
    const events: ThreadAgentEvent[] = [
      {
        type: "append_message",
        message: {
          id: "1",
          role: "tool",
          content: "r",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      },
      { type: "assistant_start", messageId: "a1", step: { id: "step-1" } },
      { type: "assistant_delta", messageId: "a1", delta: "text" },
      { type: "assistant_end", messageId: "a1" },
      {
        type: "tool_start",
        parentMessageId: "a1",
        toolCallId: "tc1",
        toolCallName: "search",
        step: { id: "step-1" },
        extra: {
          visualization: {
            owner: {
              key: "researcher:one",
              type: "researcher",
              instanceId: "one",
            },
          },
        },
      },
      { type: "tool_args", toolCallId: "tc1", delta: '{}' },
      { type: "tool_end", toolCallId: "tc1" },
      {
        type: "tool_result_start",
        messageId: "tool-message-1",
        toolCallId: "tc1",
      },
      {
        type: "tool_result_delta",
        messageId: "tool-message-1",
        toolCallId: "tc1",
        delta: '{"ok":',
      },
      {
        type: "tool_result_end",
        messageId: "tool-message-1",
        toolCallId: "tc1",
      },
      { type: "step_started", step: { id: "step-1", name: "researcher" } },
      { type: "step_finished", step: { id: "step-1", name: "researcher" } },
      { type: "run_complete" },
    ];

    // All event types should be representable
    expect(events).toHaveLength(13);
  });
});
