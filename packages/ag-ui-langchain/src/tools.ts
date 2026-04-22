/**
 * AG-UI tool event helpers for LangChain ToolMessage.
 *
 * Provides utilities to convert LangChain ToolMessage and AIMessageChunk
 * into AG-UI protocol events.
 */

import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { v4 as uuid } from "uuid";

import { contentToString } from "./convert.js";
import { withStreamEventMetadata } from "./stream.js";
import type { StreamEventMetadata } from "./types.js";

/**
 * Emit AG-UI TOOL_CALL_RESULT event for a LangChain ToolMessage.
 */
export async function* eventsFromToolMessage(
  message: BaseMessage,
  metadata: StreamEventMetadata = {},
): AsyncGenerator<BaseEvent> {
  const toolMessage = message as ToolMessage;
  const toolCallId = toolMessage.tool_call_id;

  if (!toolCallId) return;

  yield withStreamEventMetadata(
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: message.id || uuid(),
      toolCallId,
      content: contentToString(message.content),
      role: "tool",
    } as BaseEvent,
    metadata,
  );
}

/**
 * Convert a streaming AIMessageChunk into a full AIMessage.
 * Useful for pushing accumulated chunks into a message history.
 */
export function toAIMessage(chunk: AIMessageChunk): AIMessage {
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
