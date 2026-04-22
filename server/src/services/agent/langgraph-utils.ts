import type { Message, Tool } from "@ag-ui/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import { type BindToolsInput } from "@langchain/core/language_models/chat_models";

export type LangChainToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

export function contentToString(
  content: Message["content"] | MessageContent | undefined,
): string {
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

export function parseToolArgs(args: string) {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

export function toLangChainMessages(messages: Message[]): BaseMessage[] {
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

export function frontendToolToModelTool(tool: Tool): BindToolsInput {
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

export function getToolCalls(
  message: BaseMessage | undefined,
): LangChainToolCall[] {
  if (!(message instanceof AIMessage)) return [];

  return (message.tool_calls || []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
  }));
}

export function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}
