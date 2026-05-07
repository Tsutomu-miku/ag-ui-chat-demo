import { ToolMessage } from "@langchain/core/messages";

import type { LangGraphStreamEvent } from "../types.js";
import { isRecord } from "../shared/guards.js";

export type ToolMessageLike = {
  id?: string;
  name?: string;
  content?: unknown;
  tool_call_id?: string;
};

export function isToolMessageLike(value: unknown): value is ToolMessageLike {
  if (value instanceof ToolMessage) return true;
  if (!isRecord(value)) return false;
  const getType = value._getType;
  return typeof getType === "function" && getType.call(value) === "tool";
}

export function isCommandLike(value: unknown): value is { update?: unknown } {
  if (!isRecord(value)) return false;
  const constructorName =
    isRecord(value.constructor) && typeof value.constructor.name === "string"
      ? value.constructor.name
      : "";
  return constructorName === "Command" || isRecord(value.update);
}

export function commandToolMessages(output: {
  update?: unknown;
}): ToolMessageLike[] {
  const update = isRecord(output.update) ? output.update : {};
  const messages = Array.isArray(update.messages) ? update.messages : [];
  return messages.filter(isToolMessageLike);
}

export function getEventDataRecord(
  event: LangGraphStreamEvent,
): Record<string, unknown> {
  return isRecord(event.data) ? event.data : {};
}
