import type { Message } from "@ag-ui/core";

import {
  collectAssistantToolCallIds,
  isDuplicateAssistantToolCall,
} from "./message-utils.js";
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
        ...(message.stepId ? { stepId: message.stepId } : {}),
        ...(message.parentStepId ? { parentStepId: message.parentStepId } : {}),
        ...(message.stepKind ? { stepKind: message.stepKind } : {}),
        ...(message.stepName ? { stepName: message.stepName } : {}),
        ...(message.parentStepName
          ? { parentStepName: message.parentStepName }
          : {}),
        ...(message.agentId ? { agentId: message.agentId } : {}),
        ...(message.agentName ? { agentName: message.agentName } : {}),
      };
    case "tool":
      if (!message.toolCallId) return null;

      return {
        id: message.id,
        role: "tool",
        content: message.content,
        toolCallId: message.toolCallId,
        ...(message.stepId ? { stepId: message.stepId } : {}),
        ...(message.parentStepId ? { parentStepId: message.parentStepId } : {}),
        ...(message.stepKind ? { stepKind: message.stepKind } : {}),
        ...(message.stepName ? { stepName: message.stepName } : {}),
        ...(message.parentStepName
          ? { parentStepName: message.parentStepName }
          : {}),
        ...(message.agentId ? { agentId: message.agentId } : {}),
        ...(message.agentName ? { agentName: message.agentName } : {}),
      };
  }
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
    collectAssistantToolCallIds(message, knownToolCallIds);
  }

  for (const message of incomingMessages) {
    if (knownMessageIds.has(message.id)) continue;
    if (isDuplicateAssistantToolCall(message, knownToolCallIds)) continue;

    messages.push(message);
    knownMessageIds.add(message.id);
    collectAssistantToolCallIds(message, knownToolCallIds);
  }

  return messages;
}
