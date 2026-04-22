import {
  EventType,
  type BaseEvent,
  type Message,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { type BindToolsInput } from "@langchain/core/language_models/chat_models";
import { END, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
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

type GraphUpdate = Partial<{
  agent: { messages?: BaseMessage | BaseMessage[] };
  tools: { messages?: BaseMessage | BaseMessage[] };
}>;

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

function createAgentGraph(frontendTools: Tool[]) {
  const frontendToolNames = new Set(frontendTools.map((tool) => tool.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);
  const toolNode = new ToolNode(backendTools);

  const callModel = async (state: typeof MessagesAnnotation.State) => {
    const model = createAgentModel();
    const response = await model
      .bindTools([...backendTools, ...frontendModelTools])
      .invoke(state.messages);

    return { messages: [response] };
  };

  const shouldContinue = (state: typeof MessagesAnnotation.State) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const toolCalls = getToolCalls(lastMessage);

    if (toolCalls.length === 0) return END;

    const hasFrontendToolCall = toolCalls.some((toolCall) =>
      frontendToolNames.has(toolCall.name)
    );

    if (hasFrontendToolCall) return END;

    return "tools";
  };

  return new StateGraph(MessagesAnnotation)
    .addNode("agent", callModel)
    .addNode("tools", toolNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      [END]: END,
    })
    .addEdge("tools", "agent")
    .compile();
}

async function* eventsFromAIMessage(message: BaseMessage): AsyncGenerator<BaseEvent> {
  const messageId = message.id || uuid();
  const content = contentToString(message.content);
  const toolCalls = getToolCalls(message);

  if (content) {
    yield {
      type: EventType.TEXT_MESSAGE_START,
      messageId,
      role: "assistant",
    } as BaseEvent;
    yield {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      delta: content,
    } as BaseEvent;
  }

  for (const toolCall of toolCalls) {
    const toolCallId = toolCall.id || uuid();

    yield {
      type: EventType.TOOL_CALL_START,
      parentMessageId: messageId,
      toolCallId,
      toolCallName: toolCall.name,
    } as BaseEvent;
    yield {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: JSON.stringify(toolCall.args || {}),
    } as BaseEvent;
    yield {
      type: EventType.TOOL_CALL_END,
      toolCallId,
    } as BaseEvent;
  }

  if (content) {
    yield {
      type: EventType.TEXT_MESSAGE_END,
      messageId,
    } as BaseEvent;
  }
}

async function* eventsFromToolMessage(message: BaseMessage): AsyncGenerator<BaseEvent> {
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

async function* eventsFromGraphUpdate(update: GraphUpdate): AsyncGenerator<BaseEvent> {
  for (const message of asArray(update.agent?.messages)) {
    if (message._getType() === "ai") {
      yield* eventsFromAIMessage(message);
    }
  }

  for (const message of asArray(update.tools?.messages)) {
    if (message._getType() === "tool") {
      yield* eventsFromToolMessage(message);
    }
  }
}

export async function* runLangGraphAgent(
  input: RunAgentInput,
  signal?: AbortSignal
): AsyncGenerator<BaseEvent> {
  const graph = createAgentGraph(input.tools || []);
  const messages = toLangChainMessages(input.messages);

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

  const stream = await graph.stream(
    { messages },
    {
      streamMode: "updates",
      signal,
      configurable: { thread_id: input.threadId },
    } as Parameters<typeof graph.stream>[1]
  );

  for await (const update of stream) {
    if (signal?.aborted) break;
    yield* eventsFromGraphUpdate(update as GraphUpdate);
  }

  if (!signal?.aborted) {
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent;
  }
}
