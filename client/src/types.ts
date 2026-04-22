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
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCallFunction[];
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
  parameters: Record<string, any>; // JSON Schema
}

// A pending frontend tool call that needs user action
export interface PendingToolCall {
  toolCallId: string;
  toolCallName: string;
  args: Record<string, any>;
  status: "pending" | "approved" | "rejected";
  result?: string;
}
