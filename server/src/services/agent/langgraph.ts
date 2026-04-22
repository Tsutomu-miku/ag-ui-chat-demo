import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { v4 as uuid } from "uuid";

import { createLogger } from "../../config/logger.js";
import {
  asArray,
  contentToString,
  frontendToolToModelTool,
  getToolCalls,
  toLangChainMessages,
} from "./langgraph-utils.js";
import { eventsFromAIMessageStream } from "./langgraph-stream.js";
import { backendTools } from "./tools.js";
import { createAgentModel } from "./model.js";

const logger = createLogger("langgraph");

export { eventsFromAIMessageStream } from "./langgraph-stream.js";

export async function* eventsFromToolMessage(
  message: BaseMessage,
): AsyncGenerator<BaseEvent> {
  const toolMessage = message as ToolMessage;
  const toolCallId = toolMessage.tool_call_id;

  if (!toolCallId) return;

  yield {
    type: EventType.TOOL_CALL_RESULT,
    messageId: message.id || uuid(),
    toolCallId,
    content: contentToString(message.content),
    role: "tool",
  } as BaseEvent;
}

export function toAIMessage(chunk: AIMessageChunk) {
  return new AIMessage({
    id: chunk.id,
    content: contentToString(chunk.content),
    tool_calls: (chunk.tool_calls || []).map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      args: toolCall.args,
      type: "tool_call",
    })),
  });
}

export async function* runLangGraphAgent(
  input: RunAgentInput,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const messages = toLangChainMessages(input.messages);
  const frontendTools = input.tools || [];
  const frontendToolNames = new Set(frontendTools.map((tool) => tool.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);
  const boundModel = createAgentModel().bindTools([
    ...backendTools,
    ...frontendModelTools,
  ]);
  const toolNode = new ToolNode(backendTools);
  const stateMessages = [...messages];

  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent;

  logger.debug("langgraph run started", {
    threadId: input.threadId,
    messageCount: messages.length,
    backendToolCount: backendTools.length,
    frontendToolCount: input.tools?.length || 0,
  });

  while (!signal?.aborted) {
    const aiResponseStream = await boundModel.stream(stateMessages, { signal });
    const finalChunk = yield* eventsFromAIMessageStream(aiResponseStream);

    if (!finalChunk) {
      break;
    }

    const finalMessage = toAIMessage(finalChunk);
    stateMessages.push(finalMessage);

    const toolCalls = getToolCalls(finalMessage);
    if (toolCalls.length === 0) {
      break;
    }

    if (toolCalls.some((toolCall) => frontendToolNames.has(toolCall.name))) {
      break;
    }

    const toolResult = await toolNode.invoke({ messages: stateMessages });
    for (const message of asArray(toolResult.messages)) {
      stateMessages.push(message);
      if (message instanceof ToolMessage) {
        yield* eventsFromToolMessage(message);
      }
    }
  }

  if (!signal?.aborted) {
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent;
  }
}
