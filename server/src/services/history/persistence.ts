import {
  type BaseEvent,
  EventType,
  type Message,
  type ToolCall,
} from "@ag-ui/core";
import { v4 as uuid } from "uuid";

import {
  collectAssistantToolCallIds,
  isDuplicateAssistantToolCall,
  messageContentToString,
} from "./message-utils.js";
import {
  appendMessages,
  getOrCreateThread,
  type StoredMessage,
  type StoredRole,
} from "./store.js";
import { createLogger } from "../../config/logger.js";

const logger = createLogger("history");

type PersistableEvent = BaseEvent &
  Partial<{
    messageId: string;
    delta: string;
    content: string;
    toolCallId: string;
    toolCallName: string;
    parentMessageId: string;
  }>;

function isStoredRole(role: Message["role"]): role is StoredRole {
  return role === "user" || role === "assistant" || role === "tool";
}

export function persistHistory(
  threadId: string,
  inputMessages: Message[],
  events: BaseEvent[]
) {
  const thread = getOrCreateThread(threadId);
  const existingIds = new Set(thread.messages.map((message) => message.id));
  const existingToolCallIds = new Set<string>();
  const newMessages: StoredMessage[] = [];

  for (const message of thread.messages) {
    collectAssistantToolCallIds(message, existingToolCallIds);
  }

  for (const message of inputMessages) {
    if (
      !message.id ||
      existingIds.has(message.id) ||
      !isStoredRole(message.role) ||
      isDuplicateAssistantToolCall(message, existingToolCallIds)
    ) {
      continue;
    }

    const newMessage = {
      id: message.id,
      role: message.role,
      content: messageContentToString(message.content),
      toolCallId: message.role === "tool" ? message.toolCallId : undefined,
      toolCalls: message.role === "assistant" ? message.toolCalls : undefined,
      createdAt: new Date().toISOString(),
    };

    newMessages.push(newMessage);
    existingIds.add(message.id);
    collectAssistantToolCallIds(newMessage, existingToolCallIds);
  }

  let assistantCharacterCount = 0;
  let toolCallCount = 0;
  let currentAssistant:
    | {
        id: string;
        content: string;
        toolCalls: ToolCall[];
        toolCallArgs: Map<string, string>;
      }
    | undefined;

  const ensureAssistant = (messageId?: string) => {
    currentAssistant ||= {
      id: messageId || uuid(),
      content: "",
      toolCalls: [],
      toolCallArgs: new Map<string, string>(),
    };

    return currentAssistant;
  };

  const flushAssistant = () => {
    if (!currentAssistant) return;
    if (!currentAssistant.content && currentAssistant.toolCalls.length === 0) {
      currentAssistant = undefined;
      return;
    }

    const assistantMessage = {
      id: currentAssistant.id,
      role: "assistant",
      content: currentAssistant.content,
      toolCalls:
        currentAssistant.toolCalls.length > 0 ? currentAssistant.toolCalls : undefined,
      createdAt: new Date().toISOString(),
    } satisfies StoredMessage;

    if (
      !existingIds.has(assistantMessage.id) &&
      !isDuplicateAssistantToolCall(assistantMessage, existingToolCallIds)
    ) {
      newMessages.push(assistantMessage);
      existingIds.add(assistantMessage.id);
      collectAssistantToolCallIds(assistantMessage, existingToolCallIds);
      assistantCharacterCount += assistantMessage.content.length;
      toolCallCount += assistantMessage.toolCalls?.length || 0;
    }

    currentAssistant = undefined;
  };

  for (const event of events as PersistableEvent[]) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        if (currentAssistant?.id && event.messageId && currentAssistant.id !== event.messageId) {
          flushAssistant();
        }
        ensureAssistant(event.messageId);
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK:
        ensureAssistant(event.messageId).content += event.delta || "";
        break;
      case EventType.TEXT_MESSAGE_END:
        break;
      case EventType.TOOL_CALL_START:
        if (!event.toolCallId || !event.toolCallName) break;
        ensureAssistant(event.parentMessageId).toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolCallName, arguments: "" },
        });
        currentAssistant?.toolCallArgs.set(event.toolCallId, "");
        break;
      case EventType.TOOL_CALL_ARGS: {
        if (!event.toolCallId) break;
        const assistant = ensureAssistant();
        const updated =
          (assistant.toolCallArgs.get(event.toolCallId) || "") + (event.delta || "");
        const toolCall = assistant.toolCalls.find((item) => item.id === event.toolCallId);

        assistant.toolCallArgs.set(event.toolCallId, updated);
        if (toolCall) toolCall.function.arguments = updated;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        if (!event.toolCallId) break;
        flushAssistant();
        if (event.messageId && existingIds.has(event.messageId)) break;

        const toolMessageId = event.messageId || uuid();

        newMessages.push({
          id: toolMessageId,
          role: "tool",
          content: event.content || "",
          toolCallId: event.toolCallId,
          createdAt: new Date().toISOString(),
        });
        existingIds.add(toolMessageId);
        break;
    }
  }

  flushAssistant();

  if (newMessages.length > 0) {
    appendMessages(threadId, newMessages);
    logger.debug("history persisted", {
      threadId,
      inputMessageCount: inputMessages.length,
      eventCount: events.length,
      storedMessageCount: newMessages.length,
      assistantCharacterCount,
      toolCallCount,
    });
  }
}
