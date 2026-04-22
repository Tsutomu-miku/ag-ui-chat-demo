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
  /** AG-UI step metadata for tree rendering */
  stepName?: string;
  parentStepName?: string;
  createdAt: string;
}

// ── Thread (conversation) ──

export interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
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
  stepName?: string;
  parentStepName?: string;
  result?: string;
}

// ── Active step tracking for sub-agent execution ──

export interface ActiveStep {
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
      type: "step_started";
      stepName: string;
      parentStepName?: string;
    }
  | {
      type: "step_finished";
      stepName: string;
      parentStepName?: string;
    }
  | {
      type: "run_complete";
    };
