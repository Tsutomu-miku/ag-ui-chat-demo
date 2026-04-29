import { ToolMessage } from "@langchain/core/messages";

export const TEXT_MESSAGE_ID = "protocol-demo-message";
export const SUPERVISOR_HANDOFF_MESSAGE_ID = "protocol-supervisor-handoff-message";
export const WRITER_PROGRESS_MESSAGE_ID = "protocol-writer-progress-message";
export const WRITER_OUTPUT_MESSAGE_ID = "protocol-writer-output-message";
export const SUPERVISOR_SUMMARY_MESSAGE_ID = "protocol-supervisor-summary-message";
export const BACKEND_TOOL_CALL_ID = "protocol-backend-tool";
export const FRONTEND_TOOL_CALL_ID = "protocol-approval-tool";
export const WRITER_HANDOFF_TOOL_CALL_ID = "protocol-transfer-writer-tool";
export const WRITER_CALC_TOOL_CALL_ID = "protocol-writer-calc-tool";
export const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
export const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
export const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

export type StreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
};

const RUN_ID = "protocol-demo-run";
const MODEL_NAME = "ProtocolDemoModel";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageType(message: unknown): string | undefined {
  if (!isRecord(message)) return undefined;
  const getType = message._getType;
  return typeof getType === "function" ? getType.call(message) : undefined;
}

export function hasToolResume(input: unknown) {
  const messages =
    isRecord(input) && Array.isArray(input.messages) ? input.messages : [];
  return messages.some((message) => {
    if (!isRecord(message)) return false;
    return (
      message.tool_call_id === FRONTEND_TOOL_CALL_ID ||
      message.toolCallId === FRONTEND_TOOL_CALL_ID ||
      messageType(message) === "tool"
    );
  });
}

export function textChunk(
  content: string,
  node = "assistant",
  messageId = TEXT_MESSAGE_ID,
): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: messageId,
        content,
        tool_call_chunks: [],
      },
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function textEnd(
  node = "assistant",
  messageId = TEXT_MESSAGE_ID,
): StreamEvent {
  return {
    event: "on_chat_model_end",
    name: MODEL_NAME,
    data: { output: { id: messageId, content: "" } },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolCallStart(
  toolCallId: string,
  name: string,
  node = "assistant",
  messageId = TEXT_MESSAGE_ID,
): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: messageId,
        content: "",
        tool_call_chunks: [{ id: toolCallId, index: 0, name, args: "" }],
      },
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolCallArgs(
  toolCallId: string,
  args: Record<string, unknown>,
  node = "assistant",
  messageId = TEXT_MESSAGE_ID,
): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: messageId,
        content: "",
        tool_call_chunks: [
          { id: toolCallId, index: 0, name: "", args: JSON.stringify(args) },
        ],
      },
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolEnd(
  name: string,
  toolCallId: string,
  content: Record<string, unknown>,
  node = "backend_tool",
  input: Record<string, unknown> = { inspect: ["state", "messages", "tools"] },
  parentMessageId = `${toolCallId}-result`,
): StreamEvent {
  return {
    event: "on_tool_end",
    name,
    data: {
      input,
      output: new ToolMessage({
        id: parentMessageId,
        name,
        tool_call_id: toolCallId,
        content: JSON.stringify(content),
      }),
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolResultStart(
  toolCallId: string,
  messageId: string,
  node = "backend_tool",
  metadata: Record<string, unknown> = {},
): StreamEvent {
  return {
    event: "on_custom_event",
    name: TOOL_RESULT_START_EVENT,
    data: {
      toolCallId,
      messageId,
      ...metadata,
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolResultDelta(
  toolCallId: string,
  messageId: string,
  delta: string,
  node = "backend_tool",
): StreamEvent {
  return {
    event: "on_custom_event",
    name: TOOL_RESULT_DELTA_EVENT,
    data: {
      toolCallId,
      messageId,
      delta,
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function toolResultEnd(
  toolCallId: string,
  messageId: string,
  node = "backend_tool",
): StreamEvent {
  return {
    event: "on_custom_event",
    name: TOOL_RESULT_END_EVENT,
    data: {
      toolCallId,
      messageId,
    },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}

export function chainEnd(
  node: string,
  output: Record<string, unknown>,
): StreamEvent {
  return {
    event: "on_chain_end",
    name: node,
    data: { output },
    metadata: { langgraph_node: node },
    run_id: RUN_ID,
  };
}
