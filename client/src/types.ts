// ============================================================
// AG-UI Message types (matching backend StoredMessage)
// ============================================================

export interface ToolCallFunction {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
  complete?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallFunction[];
  isStreaming?: boolean;
  createdAt: string;
}

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

// ============================================================
// Frontend Tool Definitions
// These are tools that require user interaction.
// They are sent to the agent via RunAgentInput.tools.
// The agent can call them, and the frontend handles execution.
// ============================================================

export interface FrontendToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// A pending frontend tool call that needs user action
export interface PendingToolCall {
  toolCallId: string;
  toolCallName: string;
  args: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  result?: string;
}

// ============================================================
// Step tracking for sub-agent execution
// ============================================================

export interface ActiveStep {
  stepName: string;
  startedAt: string;
}

export type ThreadAgentEvent =
  | {
      type: "append_message";
      message: ChatMessage;
    }
  | {
      type: "assistant_start";
      messageId: string;
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
    }
  | {
      type: "tool_args";
      toolCallId: string;
      args: string;
    }
  | {
      type: "tool_end";
      toolCallId: string;
    }
  | {
      type: "step_started";
      stepName: string;
    }
  | {
      type: "step_finished";
      stepName: string;
    }
  | {
      type: "run_complete";
    };
