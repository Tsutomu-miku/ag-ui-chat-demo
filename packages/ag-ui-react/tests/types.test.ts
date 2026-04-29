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
      stepId: "step-1",
      parentStepId: "step-root",
      stepKind: "subagent",
      stepName: "researcher",
      parentStepName: "supervisor",
    };

    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("search");
    expect(tc.stepName).toBe("researcher");
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
      stepId: "step-root",
      stepKind: "supervisor",
      stepName: "supervisor",
      startedAt: "2024-01-01T00:00:00.000Z",
    };
    const child: ActiveStep = {
      stepId: "step-child",
      parentStepId: "step-root",
      stepKind: "subagent",
      stepName: "researcher",
      parentStepName: "supervisor",
      startedAt: "2024-01-01T00:00:00.000Z",
    };

    expect(root.parentStepName).toBeUndefined();
    expect(child.parentStepName).toBe("supervisor");
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
      { type: "assistant_start", messageId: "a1", stepId: "step-1" },
      { type: "assistant_delta", messageId: "a1", delta: "text" },
      { type: "assistant_end", messageId: "a1" },
      {
        type: "tool_start",
        parentMessageId: "a1",
        toolCallId: "tc1",
        toolCallName: "search",
        stepId: "step-1",
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
      { type: "step_started", stepId: "step-1", stepName: "researcher" },
      { type: "step_finished", stepId: "step-1", stepName: "researcher" },
      { type: "run_complete" },
      { type: "trace_event", name: "ag-ui.trace", value: { type: "span.start" } },
    ];

    // All event types should be representable
    expect(events).toHaveLength(14);
  });
});
