import type { BaseEvent } from "@ag-ui/core";
import type { CompiledStateGraph } from "@langchain/langgraph";

/**
 * AG-UI LangGraph Types
 *
 * TypeScript equivalents of Python ag_ui_langgraph.types
 * Aligned with the Python ag_ui_langgraph adapter
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

// ── JSON / state types ──

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type State = Record<string, unknown>;

export type RunnableConfigLike = Record<string, unknown> & {
  configurable?: Record<string, unknown>;
};

export type LocalCompiledGraph = CompiledStateGraph<State, Partial<State>, string>;

export type SchemaKeys = {
  input?: string[] | null;
  output?: string[] | null;
  config?: string[] | null;
  context?: string[] | null;
};

// ── Default schema keys (protocol-internal) ──

export const DEFAULT_SCHEMA_KEYS = ["messages", "tools", "ag-ui", "copilotkit"];

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
  text_started?: boolean;
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
  streamed_tool_call_ids?: Set<string>;
  model_made_tool_call?: boolean;
  state_reliable?: boolean;
  manually_emitted_state?: State | null;
  reasoning_process?: ThinkingProcess | null;
  wait_for_frontend_tool?: boolean;
};

// ── Prepared stream (from prepare_stream) ──

export type PreparedStream = {
  stream: AsyncIterable<LangGraphStreamEvent> | null;
  state: State | null;
  config: RunnableConfigLike | null;
  events_to_dispatch?: BaseEvent[];
};

// ── Forwarded props (from RunAgentInput) ──

export type ForwardedProps = {
  node_name?: string | null;
  command?: { resume?: unknown } | null;
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
  step: {
    id?: string;
    parentId?: string;
    kind?: TraceStepKind;
    name?: string;
  };
  owner: {
    key: string;
    type: string;
    instanceId: string;
    parentKey?: string;
  };
  emitterId: string;
}>;

export type TraceStepKind =
  | "supervisor"
  | "subagent"
  | "node"
  | "tool"
  | "frontend_tool";

// ── LangChain tool call extraction type ──

export type LangChainToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

// ── LangGraph runtime shapes ──

export type LangGraphStreamEvent = {
  event: string;
  name?: string;
  data?: unknown;
  metadata?: Record<string, unknown>;
  run_id?: unknown;
};

export type ToolCallChunk = {
  id?: string;
  name?: string;
  args?: unknown;
  index?: number;
};

export type InterruptLike = {
  value?: unknown;
};

export type CheckpointTaskLike = {
  interrupts?: Iterable<InterruptLike> | InterruptLike[] | null;
};

export type CheckpointSnapshotLike = {
  values?: State | null;
  tasks?: Iterable<CheckpointTaskLike | unknown> | Array<CheckpointTaskLike | unknown> | null;
  next?: string[] | readonly string[] | null;
  metadata?: Record<string, unknown> | null;
  config?: RunnableConfigLike;
};

export type GraphWithCheckpointing = {
  getState?: (config: RunnableConfigLike) => Promise<CheckpointSnapshotLike> | CheckpointSnapshotLike;
  updateState?: (
    config: RunnableConfigLike,
    state: State,
    asNode?: string,
  ) => Promise<RunnableConfigLike | unknown> | RunnableConfigLike | unknown;
  getStateHistory?: (
    config: RunnableConfigLike,
  ) => AsyncIterable<CheckpointSnapshotLike | unknown> | Iterable<CheckpointSnapshotLike | unknown>;
};
