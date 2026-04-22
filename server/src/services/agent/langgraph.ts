import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { v4 as uuid } from "uuid";

import { createLogger } from "../../config/logger.js";
import { backendTools } from "./tools.js";
import { createAgentModel } from "./model.js";

const logger = createLogger("langgraph");

type LangChainToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

function contentToString(content: Message["content"] | MessageContent | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if ("text" in part && typeof part.text === "string") return part.text;
        return `[${"type" in part ? part.type : "content"}]`;
      })
      .join("\n");
  }

  return String(content);
}

function parseToolArgs(args: string) {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

function toLangChainMessages(messages: Message[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user":
        return new HumanMessage({
          id: message.id,
          content: contentToString(message.content),
          name: message.name,
        });
      case "assistant":
        return new AIMessage({
          id: message.id,
          content: contentToString(message.content),
          name: message.name,
          tool_calls: (message.toolCalls || []).map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            args: parseToolArgs(toolCall.function.arguments),
            type: "tool_call",
          })),
        });
      case "tool":
        return new ToolMessage({
          id: message.id,
          content: message.content,
          tool_call_id: message.toolCallId,
        });
      case "system":
      case "developer":
        return new SystemMessage({
          id: message.id,
          content: message.content,
          name: message.name,
        });
      default:
        return new HumanMessage(contentToString(message.content));
    }
  });
}

function frontendToolToModelTool(tool: Tool): BindToolsInput {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || {
        type: "object",
        properties: {},
      },
    },
  };
}

function getToolCalls(message: BaseMessage | undefined): LangChainToolCall[] {
  if (!message || message._getType() !== "ai") return [];

  return ((message as AIMessage).tool_calls || []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
  }));
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function* eventsFromToolMessage(message: BaseMessage): AsyncGenerator<BaseEvent> {
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

export async function* eventsFromAIMessageStream(
  stream: AsyncIterable<BaseMessage>
): AsyncGenerator<BaseEvent, AIMessageChunk | undefined> {
  let messageId: string | undefined;
  let started = false;
  let textClosed = false;
  let finalChunk: AIMessageChunk | undefined;
  let fallbackToolCallIndex = 0;
  const toolCallStates = new Map<
    string,
    {
      emittedId: string;
      name: string;
      args: string;
      started: boolean;
      ended: boolean;
    }
  >();

  for await (const chunk of stream) {
    if (!(chunk instanceof AIMessageChunk)) {
      continue;
    }

    finalChunk = finalChunk ? finalChunk.concat(chunk) : chunk;
    messageId ||= chunk.id || uuid();

    const textDelta = contentToString(chunk.content);
    if (textDelta) {
      if (!started) {
        started = true;
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        } as BaseEvent;
      }

      if (textClosed && messageId) {
        yield {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        } as BaseEvent;
        textClosed = false;
      }

      yield {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId,
        delta: textDelta,
      } as BaseEvent;
    }

    for (const toolCallChunk of chunk.tool_call_chunks || []) {
      const stateKey =
        typeof toolCallChunk.index === "number"
          ? `index:${toolCallChunk.index}`
          : toolCallChunk.id
            ? `id:${toolCallChunk.id}`
            : `fallback:${fallbackToolCallIndex++}`;
      const state = toolCallStates.get(stateKey) || {
        emittedId: toolCallChunk.id || uuid(),
        name: toolCallChunk.name || "unknown_tool",
        args: "",
        started: false,
        ended: false,
      };
      const toolCallId = state.emittedId;

      if (started && !textClosed && messageId) {
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId,
        } as BaseEvent;
        textClosed = true;
      }

      if (toolCallChunk.name) {
        state.name = toolCallChunk.name;
      }

      if (toolCallChunk.id && state.emittedId !== toolCallChunk.id) {
        state.emittedId = toolCallChunk.id;
      }

      if (!state.started) {
        state.started = true;
        yield {
          type: EventType.TOOL_CALL_START,
          parentMessageId: messageId,
          toolCallId,
          toolCallName: state.name,
        } as BaseEvent;
      }

      if (toolCallChunk.args) {
        state.args += toolCallChunk.args;
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: toolCallChunk.args,
        } as BaseEvent;
      }

      toolCallStates.set(stateKey, state);
    }
  }

  if (finalChunk) {
    for (const toolCall of finalChunk.tool_calls || []) {
      const toolCallId = toolCall.id || uuid();
      const state = Array.from(toolCallStates.values()).find(
        (item) => item.emittedId === toolCallId
      );

      if (state && !state.ended) {
        state.ended = true;
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as BaseEvent;
      }
    }
  }

  if (started && messageId && !textClosed) {
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    } as BaseEvent;
  }

  return finalChunk;
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
  signal?: AbortSignal
): AsyncGenerator<BaseEvent> {
  const messages = toLangChainMessages(input.messages);
  const frontendTools = input.tools || [];
  const frontendToolNames = new Set(frontendTools.map((tool) => tool.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);
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
    const boundModel = createAgentModel().bindTools([
      ...backendTools,
      ...frontendModelTools,
    ]);

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
      if (message._getType() === "tool") {
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
