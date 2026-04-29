/**
 * ag-ui-react types — Generic AG-UI chat state types.
 *
 * These are framework-agnostic data structures used by all hooks and utilities.
 * Consumers can extend them for their own UI needs.
 *
 * @packageDocumentation
 */

// ── Tool call within a chat message ──

export interface ToolCallFunction {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  /** Whether the tool call has completed (received result) */
  complete?: boolean;
  /** AG-UI step metadata for tree rendering */
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
}

// ── Chat message ──

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  /** For tool result messages: the ID of the tool call this responds to */
  toolCallId?: string;
  /** Tool calls initiated by this assistant message */
  toolCalls?: ToolCallFunction[];
  /** Whether the message is currently being streamed */
  isStreaming?: boolean;
  /** Streaming reasoning text (chain-of-thought / thinking output) */
  reasoning?: string;
  /** Whether the reasoning stream is still in progress */
  isReasoningStreaming?: boolean;
  /** AG-UI step metadata for tree rendering */
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
  createdAt: string;
}

export interface TraceEvent {
  type: string;
  sequence?: number;
  createdAt?: string;
  runId?: string;
  name?: string;
  value?: unknown;
  messageId?: string;
  parentMessageId?: string;
  role?: string;
  delta?: string;
  content?: string;
  toolCallId?: string;
  toolCallName?: string;
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
}

export const AG_UI_TRACE_EVENT_NAME = "ag-ui.trace";
export const AG_UI_TRACE_PROTOCOL_VERSION = 1;

export type AgUiTraceEvent =
  | {
      version?: typeof AG_UI_TRACE_PROTOCOL_VERSION;
      type: "span.start";
      spanId: string;
      name: string;
      kind: string;
      parentSpanId?: string;
      source?: Record<string, unknown>;
    }
  | {
      version?: typeof AG_UI_TRACE_PROTOCOL_VERSION;
      type: "span.end";
      spanId: string;
      source?: Record<string, unknown>;
    }
  | {
      version?: typeof AG_UI_TRACE_PROTOCOL_VERSION;
      type: "message.link";
      messageId: string;
      spanId: string;
      role?: string;
      source?: Record<string, unknown>;
    }
  | {
      version?: typeof AG_UI_TRACE_PROTOCOL_VERSION;
      type: "tool.link";
      toolCallId: string;
      spanId: string;
      toolCallName?: string;
      parentMessageId?: string;
      source?: Record<string, unknown>;
    };

// ── Thread (conversation) ──

export interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  traceEvents?: TraceEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

// ── Frontend tool definitions ──

export interface FrontendToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface PendingToolCall {
  toolCallId: string;
  toolCallName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
  result?: string;
}

// ── Active step tracking for sub-agent execution ──

export interface ActiveStep {
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName: string;
  parentStepName?: string;
  startedAt: string;
}

// ── Thread agent events ──
// These events drive the state machine that updates ChatMessage[].
// They map 1:1 to AG-UI protocol events but use a simplified shape
// suitable for React state reducers.

export type ThreadAgentEvent =
  | {
      type: "append_message";
      message: ChatMessage;
    }
  | {
      type: "assistant_start";
      messageId: string;
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName?: string;
      parentStepName?: string;
    }
  | {
      type: "assistant_delta";
      messageId: string;
      delta: string;
    }
  | {
      type: "assistant_end";
      messageId: string;
    }
  | {
      type: "tool_start";
      parentMessageId: string;
      toolCallId: string;
      toolCallName: string;
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName?: string;
      parentStepName?: string;
    }
  | {
      type: "tool_args";
      toolCallId: string;
      delta: string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
    }
  | {
      type: "tool_result_start";
      messageId: string;
      toolCallId: string;
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName?: string;
      parentStepName?: string;
    }
  | {
      type: "tool_result_delta";
      messageId: string;
      toolCallId: string;
      delta: string;
    }
  | {
      type: "tool_result_end";
      messageId: string;
      toolCallId: string;
    }
  | {
      type: "step_started";
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName: string;
      parentStepName?: string;
    }
  | {
      type: "reasoning_start";
      messageId: string;
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName?: string;
      parentStepName?: string;
    }
  | {
      type: "reasoning_delta";
      messageId: string;
      delta: string;
    }
  | {
      type: "reasoning_end";
      messageId: string;
    }
  | {
      type: "step_finished";
      stepId?: string;
      parentStepId?: string;
      stepKind?: string;
      stepName: string;
      parentStepName?: string;
    }
  | {
      type: "run_complete";
    }
  | {
      type: "trace_event";
      name: string;
      value: unknown;
    };
