import type { Message, ToolCall } from "@ag-ui/core";

type AssistantMessageLike = {
  role: Message["role"];
  content?: Message["content"] | string;
  toolCalls?: ToolCall[];
};

export function messageContentToString(
  content: Message["content"] | string | undefined,
): string {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
      .join("\n");
  }

  return "";
}

export function collectAssistantToolCallIds(
  message: Pick<AssistantMessageLike, "role" | "toolCalls">,
  target: Set<string>,
) {
  if (message.role !== "assistant") {
    return;
  }

  for (const toolCall of message.toolCalls || []) {
    target.add(toolCall.id);
  }
}

export function isDuplicateAssistantToolCall(
  message: AssistantMessageLike,
  knownToolCallIds: Set<string>,
) {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return false;
  }

  if (messageContentToString(message.content).trim()) {
    return false;
  }

  return message.toolCalls.every((toolCall) =>
    knownToolCallIds.has(toolCall.id),
  );
}
