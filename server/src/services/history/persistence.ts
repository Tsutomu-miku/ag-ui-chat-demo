import { type BaseEvent, EventType, type Message } from "@ag-ui/core";
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
  type StoredOwner,
  type StoredRole,
  type StoredStep,
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
    step: StoredStep;
    owner: StoredOwner;
  }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStoredStep(value: unknown): StoredStep | undefined {
  if (!isRecord(value)) return undefined;

  const nested = isRecord(value.step) ? value.step : null;
  if (!nested) return undefined;

  return {
    ...(typeof nested.id === "string" ? { id: nested.id } : {}),
    ...(typeof nested.parentId === "string"
      ? { parentId: nested.parentId }
      : {}),
    ...(typeof nested.kind === "string" ? { kind: nested.kind } : {}),
    ...(typeof nested.name === "string" ? { name: nested.name } : {}),
  };
}

function getStoredOwner(value: unknown): StoredOwner | undefined {
  if (!isRecord(value)) return undefined;

  const nested = isRecord(value.owner) ? value.owner : null;
  if (
    !nested ||
    typeof nested.key !== "string" ||
    typeof nested.type !== "string" ||
    typeof nested.instanceId !== "string"
  ) {
    return undefined;
  }

  return {
    key: nested.key,
    type: nested.type,
    instanceId: nested.instanceId,
    ...(typeof nested.parentKey === "string"
      ? { parentKey: nested.parentKey }
      : {}),
  };
}

function getStoredContext(value: unknown) {
  return {
    ...(getStoredStep(value) ? { step: getStoredStep(value) } : {}),
    ...(getStoredOwner(value) ? { owner: getStoredOwner(value) } : {}),
  };
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
    messageId:
      typeof value.messageId === "string" ? value.messageId : undefined,
    toolCallId:
      typeof value.toolCallId === "string" ? value.toolCallId : undefined,
    delta: typeof value.delta === "string" ? value.delta : undefined,
    ...getStoredContext({ ...event, ...value }),
  };
}

function isStoredRole(role: Message["role"]): role is StoredRole {
  return role === "user" || role === "assistant" || role === "tool";
}

export function persistHistory(
  threadId: string,
  inputMessages: Message[],
  events: BaseEvent[],
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
      step: (message as Partial<StoredMessage>).step,
      owner: (message as Partial<StoredMessage>).owner,
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
        step?: StoredStep;
        owner?: StoredOwner;
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

    currentAssistant.step ||= event ? getStoredStep(event) : undefined;
    currentAssistant.owner ||= event ? getStoredOwner(event) : undefined;

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
        currentAssistant.toolCalls.length > 0
          ? currentAssistant.toolCalls
          : undefined,
      step: currentAssistant.step,
      owner: currentAssistant.owner,
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
          step: existing.step ?? payload.step,
          owner: existing.owner ?? payload.owner,
        }
      : {
          id: messageId,
          role: "tool",
          content: "",
          toolCallId,
          step: payload.step,
          owner: payload.owner,
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
        getStoredContext(customToolResult),
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
        if (
          currentAssistant?.id &&
          event.messageId &&
          currentAssistant.id !== event.messageId
        ) {
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
          ...getStoredContext(event),
        });
        currentAssistant?.toolCallArgs.set(event.toolCallId, "");
        break;
      case EventType.TOOL_CALL_ARGS: {
        if (!event.toolCallId) break;
        const assistant = ensureAssistant(undefined, event);
        const updated =
          (assistant.toolCallArgs.get(event.toolCallId) || "") +
          (event.delta || "");
        const toolCall = assistant.toolCalls.find(
          (item) => item.id === event.toolCallId,
        );

        assistant.toolCallArgs.set(event.toolCallId, updated);
        if (toolCall) toolCall.function.arguments = updated;
        break;
      }
      case EventType.TOOL_CALL_RESULT:
        if (!event.toolCallId) break;
        flushAssistant();
        const toolMessageId = event.messageId || uuid();
        if (
          existingIds.has(toolMessageId) &&
          !toolResultMessages.has(toolMessageId)
        ) {
          break;
        }

        const toolMessage = ensureToolResultMessage(
          toolMessageId,
          event.toolCallId,
          getStoredContext(event),
        );
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
