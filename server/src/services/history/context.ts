import type { Message } from "@ag-ui/core";

import { getOrCreateThread, type StoredMessage } from "./store.js";

function storedMessageToMessage(message: StoredMessage): Message | null {
  switch (message.role) {
    case "user":
      return {
        id: message.id,
        role: "user",
        content: message.content,
      };
    case "assistant":
      return {
        id: message.id,
        role: "assistant",
        content: message.content,
        toolCalls: message.toolCalls,
      };
    case "tool":
      if (!message.toolCallId) return null;

      return {
        id: message.id,
        role: "tool",
        content: message.content,
        toolCallId: message.toolCallId,
      };
  }
}

function collectToolCallIds(message: Message, target: Set<string>) {
  if (message.role !== "assistant") return;

  for (const toolCall of message.toolCalls || []) {
    target.add(toolCall.id);
  }
}

function isDuplicateAssistantToolCall(message: Message, knownToolCallIds: Set<string>) {
  if (message.role !== "assistant" || !message.toolCalls?.length) {
    return false;
  }

  if (message.content?.trim()) {
    return false;
  }

  return message.toolCalls.every((toolCall) => knownToolCallIds.has(toolCall.id));
}

export function buildMessagesWithHistory(threadId: string, incomingMessages: Message[]) {
  const thread = getOrCreateThread(threadId);
  const messages: Message[] = [];
  const knownMessageIds = new Set<string>();
  const knownToolCallIds = new Set<string>();

  for (const storedMessage of thread.messages) {
    const message = storedMessageToMessage(storedMessage);
    if (!message) continue;

    messages.push(message);
    knownMessageIds.add(message.id);
    collectToolCallIds(message, knownToolCallIds);
  }

  for (const message of incomingMessages) {
    if (knownMessageIds.has(message.id)) continue;
    if (isDuplicateAssistantToolCall(message, knownToolCallIds)) continue;

    messages.push(message);
    knownMessageIds.add(message.id);
    collectToolCallIds(message, knownToolCallIds);
  }

  return messages;
}
