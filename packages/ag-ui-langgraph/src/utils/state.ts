import type { RunAgentInput, Tool } from "@ag-ui/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { normalizeToolContent } from "./convert.js";
import type { State } from "../types.js";

export const A2UI_SCHEMA_CONTEXT_DESCRIPTION =
  "A2UI Component Schema — available components for generating UI surfaces.\nUse these component names and props when creating A2UI operations.";

export const ORPHAN_TOOL_MESSAGE_RE =
  /^(?:Error: No tool call found with id|Tool call '.+' with id '.+' was interrupted before completion\.)/;

export function filterOrphanToolMessages(messages: any[]): any[] {
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i] instanceof HumanMessage ||
      messages[i]?._getType?.() === "human"
    ) {
      lastHumanIdx = i;
      break;
    }
  }

  if (lastHumanIdx === -1) return messages;

  const head = messages.slice(0, lastHumanIdx + 1);
  const tail = messages.slice(lastHumanIdx + 1).filter((message) => {
    return !(
      (message instanceof ToolMessage || message?._getType?.() === "tool") &&
      typeof message.content === "string" &&
      ORPHAN_TOOL_MESSAGE_RE.test(message.content)
    );
  });

  return [...head, ...tail];
}

function stripLeadingSystemMessage(messages: BaseMessage[]): BaseMessage[] {
  if (
    messages.length > 0 &&
    (messages[0] instanceof SystemMessage ||
      messages[0]._getType?.() === "system")
  ) {
    return messages.slice(1);
  }
  return messages;
}

function normalizePersistedToolArgs(messages: BaseMessage[]): void {
  for (const message of messages) {
    if (!(message instanceof AIMessage) && message?._getType?.() !== "ai") {
      continue;
    }
    const toolCalls = (message as AIMessage).tool_calls ?? [];
    for (const toolCall of toolCalls as Array<Record<string, any>>) {
      if (typeof toolCall.args !== "string") continue;
      try {
        toolCall.args = JSON.parse(toolCall.args);
      } catch {
        toolCall.args = {};
      }
    }
  }
}

function repairInterruptedToolMessages(
  existingMessages: BaseMessage[],
  incomingMessages: BaseMessage[],
): Set<string> {
  const aguiToolContent = new Map<string, unknown>();
  for (const message of incomingMessages) {
    if (message instanceof ToolMessage || message?._getType?.() === "tool") {
      const toolCallId = (message as ToolMessage).tool_call_id;
      if (toolCallId) aguiToolContent.set(toolCallId, message.content);
    }
  }

  const replacedToolCallIds = new Set<string>();
  if (aguiToolContent.size === 0) return replacedToolCallIds;

  let lastHumanIdx = -1;
  for (let i = existingMessages.length - 1; i >= 0; i--) {
    if (
      existingMessages[i] instanceof HumanMessage ||
      existingMessages[i]?._getType?.() === "human"
    ) {
      lastHumanIdx = i;
      break;
    }
  }
  if (lastHumanIdx < 0) return replacedToolCallIds;

  for (let i = lastHumanIdx + 1; i < existingMessages.length; i++) {
    const message = existingMessages[i];
    const toolCallId = (message as ToolMessage).tool_call_id;
    if (
      (message instanceof ToolMessage || message?._getType?.() === "tool") &&
      typeof message.content === "string" &&
      ORPHAN_TOOL_MESSAGE_RE.test(message.content) &&
      toolCallId &&
      aguiToolContent.has(toolCallId)
    ) {
      (message as ToolMessage).content = normalizeToolContent(
        aguiToolContent.get(toolCallId),
      );
      replacedToolCallIds.add(toolCallId);
    }
  }

  return replacedToolCallIds;
}

function appendOnlyNewMessages(
  existingMessages: BaseMessage[],
  incomingMessages: BaseMessage[],
  replacedToolCallIds: Set<string>,
): BaseMessage[] {
  const existingMessageIds = new Set(
    existingMessages.map((message) => message.id).filter(Boolean),
  );

  return incomingMessages.filter((message) => {
    if (message.id && existingMessageIds.has(message.id)) return false;
    const toolCallId = (message as ToolMessage).tool_call_id;
    return !(
      (message instanceof ToolMessage || message?._getType?.() === "tool") &&
      toolCallId &&
      replacedToolCallIds.has(toolCallId)
    );
  });
}

function uniqueTools(inputTools: Tool[], stateTools: unknown[]): unknown[] {
  const result: unknown[] = [];
  const seenToolNames = new Set<string>();

  for (const tool of [...inputTools, ...stateTools]) {
    const toolName =
      tool && typeof tool === "object"
        ? ((tool as { name?: string }).name ?? null)
        : null;
    if (!toolName) {
      result.push(tool);
      continue;
    }
    if (seenToolNames.has(toolName)) continue;
    seenToolNames.add(toolName);
    result.push(tool);
  }

  return result;
}

function splitA2uiContext(input: RunAgentInput): {
  a2uiSchema?: unknown;
  regularContext: unknown[];
} {
  const context = Array.isArray((input as any).context)
    ? ((input as any).context as Array<Record<string, unknown>>)
    : [];
  let a2uiSchema: unknown;
  const regularContext: unknown[] = [];

  for (const entry of context) {
    const description =
      entry && typeof entry === "object"
        ? (entry as { description?: unknown }).description
        : undefined;
    if (description === A2UI_SCHEMA_CONTEXT_DESCRIPTION) {
      a2uiSchema = (entry as { value?: unknown }).value ?? "";
    } else {
      regularContext.push(entry);
    }
  }

  return { a2uiSchema, regularContext };
}

/**
 * Merge frontend RunAgentInput into LangGraph state while preserving checkpoint
 * history. This is intentionally pure except for repairing interrupted tool
 * messages in-place, matching LangGraph checkpoint semantics.
 */
export function mergeLangGraphState(opts: {
  state: State;
  messages: BaseMessage[];
  input: RunAgentInput;
}): State {
  const messages = stripLeadingSystemMessage(opts.messages);
  const existingMessages = Array.isArray(opts.state.messages)
    ? (opts.state.messages as BaseMessage[])
    : [];

  normalizePersistedToolArgs(existingMessages);
  const replacedToolCallIds = repairInterruptedToolMessages(
    existingMessages,
    messages,
  );
  const newMessages = appendOnlyNewMessages(
    existingMessages,
    messages,
    replacedToolCallIds,
  );

  const tools = uniqueTools(
    opts.input.tools ?? [],
    Array.isArray(opts.state.tools) ? opts.state.tools : [],
  );
  const { a2uiSchema, regularContext } = splitA2uiContext(opts.input);
  const agUiState: Record<string, unknown> = {
    tools,
    context: regularContext,
  };
  if (a2uiSchema !== undefined) {
    agUiState.a2ui_schema = a2uiSchema;
  }

  const previousCopilotkit =
    opts.state.copilotkit &&
    typeof opts.state.copilotkit === "object" &&
    !Array.isArray(opts.state.copilotkit)
      ? (opts.state.copilotkit as Record<string, unknown>)
      : {};

  return {
    ...opts.state,
    messages: newMessages,
    tools,
    "ag-ui": agUiState,
    copilotkit: {
      ...previousCopilotkit,
      actions: tools,
    },
  };
}
