/**
 * AG-UI LangGraph Types
 *
 * TypeScript equivalents of Python ag_ui_langgraph.types
 * Aligned with Python v0.0.34
 */

// ── LangGraph internal event types (from astream_events) ──

export enum LangGraphEventTypes {
  OnChainStart = "on_chain_start",
  OnChainStream = "on_chain_stream",
  OnChainEnd = "on_chain_end",
  OnChatModelStart = "on_chat_model_start",
  OnChatModelStream = "on_chat_model_stream",
  OnChatModelEnd = "on_chat_model_end",
  OnToolStart = "on_tool_start",
  OnToolEnd = "on_tool_end",
  OnToolError = "on_tool_error",
  OnCustomEvent = "on_custom_event",
  OnInterrupt = "on_interrupt",
}

export enum CustomEventNames {
  ManuallyEmitMessage = "manually_emit_message",
  ManuallyEmitToolCall = "manually_emit_tool_call",
  ManuallyEmitState = "manually_emit_state",
  Exit = "exit",
}

// ── State types ──

export type State = Record<string, unknown>;

export type SchemaKeys = {
  input?: string[] | null;
  output?: string[] | null;
  config?: string[] | null;
  context?: string[] | null;
};

// ── Default schema keys (protocol-internal) ──

export const DEFAULT_SCHEMA_KEYS = ["messages", "tools"];

// ── Reasoning / thinking process ──

export type ThinkingProcess = {
  index: number;
  message_id?: string;
  type?: string | null;
  signature?: string | null;
};

export type LangGraphReasoning = {
  type: string;
  text: string;
  index: number;
  signature?: string | null;
};

// ── Message tracking ──

export type MessageInProgress = {
  id: string;
  tool_call_id?: string | null;
  tool_call_name?: string | null;
  tool_call_info_by_index?: Record<
    number,
    {
      id: string;
      name: string;
    }
  >;
  active_tool_calls?: Record<
    string,
    {
      name: string;
      index: number;
    }
  >;
};

export type MessagesInProgressRecord = Record<string, MessageInProgress | null>;

// ── Run metadata (aligned with Python RunMetadata TypedDict) ──

export type RunMetadata = {
  /** Unique run identifier */
  id: string;
  thread_id?: string | null;
  /** Run mode: "start" (new run) or "continue" (e.g. after interrupt) */
  mode?: "start" | "continue";
  /** Current graph node name */
  node_name?: string | null;
  prev_node_name?: string | null;
  schema_keys?: SchemaKeys | null;
  has_function_streaming?: boolean;
  model_made_tool_call?: boolean;
  state_reliable?: boolean;
  manually_emitted_state?: State | null;
  reasoning_process?: ThinkingProcess | null;
  wait_for_frontend_tool?: boolean;
};

// ── Prepared stream (from prepare_stream) ──

export type PreparedStream = {
  stream: AsyncIterable<any> | null;
  state: State | null;
  config: Record<string, any> | null;
  events_to_dispatch?: any[];
};

// ── Forwarded props (from RunAgentInput) ──

export type ForwardedProps = {
  node_name?: string | null;
  command?: { resume?: any } | null;
  stream_subgraphs?: boolean;
  frontendToolResume?: { toolCallId?: string } | null;
  frontend_tool_resume?: { tool_call_id?: string; toolCallId?: string } | null;
  [key: string]: unknown;
};

// ── Tool call type ──

export type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

// ── LangGraph Platform message types (remote API) ──

export type BaseLangGraphPlatformMessage = {
  content: string;
  role: string;
  additional_kwargs?: Record<string, unknown>;
  type: string;
  id: string;
};

export type LangGraphPlatformResultMessage = BaseLangGraphPlatformMessage & {
  tool_call_id: string;
  name: string;
};

export type LangGraphPlatformActionExecutionMessage =
  BaseLangGraphPlatformMessage & {
    tool_calls: ToolCall[];
  };

export type LangGraphPlatformMessage =
  | LangGraphPlatformActionExecutionMessage
  | LangGraphPlatformResultMessage
  | BaseLangGraphPlatformMessage;

// ── Predict-state tool config ──

export type PredictStateTool = {
  tool: string;
  state_key: string;
  tool_argument: string;
};

// ── Stream event metadata (for step hierarchy) ──

export type StreamEventMetadata = Partial<{
  stepName: string;
  parentStepName: string;
}>;

// ── LangChain tool call extraction type ──

export type LangChainToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};
