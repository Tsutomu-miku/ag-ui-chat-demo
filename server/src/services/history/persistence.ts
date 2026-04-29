import {
  type BaseEvent,
  EventType,
  type Message,
} from "@ag-ui/core";
import { v4 as uuid } from "uuid";

import {
  collectAssistantToolCallIds,
  isDuplicateAssistantToolCall,
  messageContentToString,
} from "./message-utils.js";
import {
  appendTraceEvents,
  appendMessages,
  getOrCreateThread,
  type StoredMessage,
  type StoredRole,
  type StoredToolCall,
} from "./store.js";
import { createLogger } from "../../config/logger.js";
import { toStoredTraceEvents } from "./trace-events.js";

const logger = createLogger("history");
const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

type PersistableEvent = BaseEvent &
  Partial<{
    messageId: string;
    delta: string;
    content: string;
    toolCallId: string;
    toolCallName: string;
    parentMessageId: string;
    stepId: string;
    parentStepId: string;
    stepKind: string;
    stepName: string;
    parentStepName: string;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCustomToolResultPayload(event: PersistableEvent) {
  if (event.type !== EventType.CUSTOM || !event.name) return null;
  if (
    event.name !== TOOL_RESULT_START_EVENT &&
    event.name !== TOOL_RESULT_DELTA_EVENT &&
    event.name !== TOOL_RESULT_END_EVENT
  ) {
    return null;
  }

  const value = isRecord(event.value) ? event.value : null;
  if (!value) return null;

  return {
    eventName: event.name,
    messageId: typeof value.messageId === "string" ? value.messageId : undefined,
    toolCallId:
      typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    delta: typeof value.delta === "string" ? value.delta : undefined,
    stepId: typeof value.stepId === "string" ? value.stepId : undefined,
    parentStepId:
      typeof value.parentStepId === "string" ? value.parentStepId : undefined,
    stepKind: typeof value.stepKind === "string" ? value.stepKind : undefined,
    stepName: typeof value.stepName === "string" ? value.stepName : undefined,
    parentStepName:
      typeof value.parentStepName === "string"
        ? value.parentStepName
        : undefined,
  };
}

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
      stepId: (message as Partial<StoredMessage>).stepId,
      parentStepId: (message as Partial<StoredMessage>).parentStepId,
      stepKind: (message as Partial<StoredMessage>).stepKind,
      stepName: (message as Partial<StoredMessage>).stepName,
      parentStepName: (message as Partial<StoredMessage>).parentStepName,
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
        toolCalls: StoredToolCall[];
        toolCallArgs: Map<string, string>;
        stepId?: string;
        parentStepId?: string;
        stepKind?: string;
        stepName?: string;
        parentStepName?: string;
      }
    | undefined;
  const toolResultMessages = new Map<
    string,
    StoredMessage & { isStreaming?: boolean }
  >();

  const ensureAssistant = (messageId?: string, event?: PersistableEvent) => {
    currentAssistant ||= {
      id: messageId || uuid(),
      content: "",
      toolCalls: [],
      toolCallArgs: new Map<string, string>(),
    };

    currentAssistant.stepId ||= event?.stepId;
    currentAssistant.parentStepId ||= event?.parentStepId;
    currentAssistant.stepKind ||= event?.stepKind;
    currentAssistant.stepName ||= event?.stepName;
    currentAssistant.parentStepName ||= event?.parentStepName;

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
      stepId: currentAssistant.stepId,
      parentStepId: currentAssistant.parentStepId,
      stepKind: currentAssistant.stepKind,
      stepName: currentAssistant.stepName,
      parentStepName: currentAssistant.parentStepName,
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

  const ensureToolResultMessage = (
    messageId: string,
    toolCallId: string,
    payload: Partial<StoredMessage>,
  ) => {
    const existing =
      toolResultMessages.get(messageId) ??
      thread.messages.find((message) => message.id === messageId);
    const nextMessage: StoredMessage & { isStreaming?: boolean } = existing
      ? {
          ...existing,
          role: "tool",
          toolCallId,
          stepId: existing.stepId ?? payload.stepId,
          parentStepId: existing.parentStepId ?? payload.parentStepId,
          stepKind: existing.stepKind ?? payload.stepKind,
          stepName: existing.stepName ?? payload.stepName,
          parentStepName: existing.parentStepName ?? payload.parentStepName,
        }
      : {
          id: messageId,
          role: "tool",
          content: "",
          toolCallId,
          stepId: payload.stepId,
          parentStepId: payload.parentStepId,
          stepKind: payload.stepKind,
          stepName: payload.stepName,
          parentStepName: payload.parentStepName,
          createdAt: new Date().toISOString(),
        };

    toolResultMessages.set(messageId, nextMessage);
    return nextMessage;
  };

  for (const event of events as PersistableEvent[]) {
    const customToolResult = getCustomToolResultPayload(event);
    if (customToolResult) {
      if (!customToolResult.messageId || !customToolResult.toolCallId) continue;
      flushAssistant();
      const toolMessage = ensureToolResultMessage(
        customToolResult.messageId,
        customToolResult.toolCallId,
        {
          stepId: customToolResult.stepId,
          parentStepId: customToolResult.parentStepId,
          stepKind: customToolResult.stepKind,
          stepName: customToolResult.stepName,
          parentStepName: customToolResult.parentStepName,
        },
      );

      if (customToolResult.eventName === TOOL_RESULT_DELTA_EVENT) {
        toolMessage.content += customToolResult.delta || "";
        toolMessage.isStreaming = true;
      }

      if (customToolResult.eventName === TOOL_RESULT_END_EVENT) {
        toolMessage.isStreaming = false;
      }
      continue;
    }

    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        if (currentAssistant?.id && event.messageId && currentAssistant.id !== event.messageId) {
          flushAssistant();
        }
        ensureAssistant(event.messageId, event);
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.TEXT_MESSAGE_CHUNK:
        ensureAssistant(event.messageId, event).content += event.delta || "";
        break;
      case EventType.TEXT_MESSAGE_END:
        break;
      case EventType.TOOL_CALL_START:
        if (!event.toolCallId || !event.toolCallName) break;
        ensureAssistant(event.parentMessageId, event).toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolCallName, arguments: "" },
          stepId: event.stepId,
          parentStepId: event.parentStepId,
          stepKind: event.stepKind,
          stepName: event.stepName,
          parentStepName: event.parentStepName,
        });
        currentAssistant?.toolCallArgs.set(event.toolCallId, "");
        break;
      case EventType.TOOL_CALL_ARGS: {
        if (!event.toolCallId) break;
        const assistant = ensureAssistant(undefined, event);
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
        const toolMessageId = event.messageId || uuid();
        if (existingIds.has(toolMessageId) && !toolResultMessages.has(toolMessageId)) {
          break;
        }

        const toolMessage = ensureToolResultMessage(toolMessageId, event.toolCallId, {
          stepId: event.stepId,
          parentStepId: event.parentStepId,
          stepKind: event.stepKind,
          stepName: event.stepName,
          parentStepName: event.parentStepName,
        });
        toolMessage.content = event.content || toolMessage.content;
        toolMessage.isStreaming = false;
        break;
    }
  }

  flushAssistant();

  for (const toolMessage of toolResultMessages.values()) {
    const { isStreaming: _ignored, ...storedMessage } = toolMessage;
    if (existingIds.has(storedMessage.id)) continue;
    newMessages.push(storedMessage);
    existingIds.add(storedMessage.id);
  }

  if (newMessages.length > 0) {
    appendMessages(threadId, newMessages);
  }

  const traceEvents = toStoredTraceEvents(events, thread.traceEvents.length);
  if (traceEvents.length > 0) {
    appendTraceEvents(threadId, traceEvents);
  }

  if (newMessages.length > 0 || traceEvents.length > 0) {
    logger.debug("history persisted", {
      threadId,
      inputMessageCount: inputMessages.length,
      eventCount: events.length,
      storedMessageCount: newMessages.length,
      storedTraceEventCount: traceEvents.length,
      assistantCharacterCount,
      toolCallCount,
    });
  }
}
