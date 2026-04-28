import { ToolMessage } from "@langchain/core/messages";

export const TEXT_MESSAGE_ID = "protocol-demo-message";
export const BACKEND_TOOL_CALL_ID = "protocol-backend-tool";
export const FRONTEND_TOOL_CALL_ID = "protocol-approval-tool";

export type StreamEvent = {
  event: string;
  name?: string;
  data?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  run_id?: string;
};

const RUN_ID = "protocol-demo-run";
const MODEL_NAME = "ProtocolDemoModel";

export function hasToolResume(input: { messages?: unknown[] }) {
  return (input.messages ?? []).some((message: any) => {
    return (
      message?.tool_call_id === FRONTEND_TOOL_CALL_ID ||
      message?.toolCallId === FRONTEND_TOOL_CALL_ID ||
      message?._getType?.() === "tool"
    );
  });
}

export function textChunk(content: string): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: TEXT_MESSAGE_ID,
        content,
        tool_call_chunks: [],
      },
    },
    metadata: { langgraph_node: "assistant" },
    run_id: RUN_ID,
  };
}

export function textEnd(): StreamEvent {
  return {
    event: "on_chat_model_end",
    name: MODEL_NAME,
    data: { output: { id: TEXT_MESSAGE_ID, content: "" } },
    metadata: { langgraph_node: "assistant" },
    run_id: RUN_ID,
  };
}

export function toolCallStart(toolCallId: string, name: string): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: TEXT_MESSAGE_ID,
        content: "",
        tool_call_chunks: [{ id: toolCallId, index: 0, name, args: "" }],
      },
    },
    metadata: { langgraph_node: "assistant" },
    run_id: RUN_ID,
  };
}

export function toolCallArgs(
  toolCallId: string,
  args: Record<string, unknown>,
): StreamEvent {
  return {
    event: "on_chat_model_stream",
    name: MODEL_NAME,
    data: {
      chunk: {
        id: TEXT_MESSAGE_ID,
        content: "",
        tool_call_chunks: [
          { id: toolCallId, index: 0, name: "", args: JSON.stringify(args) },
        ],
      },
    },
    metadata: { langgraph_node: "assistant" },
    run_id: RUN_ID,
  };
}

export function toolEnd(
  name: string,
  toolCallId: string,
  content: Record<string, unknown>,
): StreamEvent {
  return {
    event: "on_tool_end",
    name,
    data: {
      input: { inspect: ["state", "messages", "tools"] },
      output: new ToolMessage({
        id: `${toolCallId}-result`,
        name,
        tool_call_id: toolCallId,
        content: JSON.stringify(content),
      }),
    },
    metadata: { langgraph_node: "backend_tool" },
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
