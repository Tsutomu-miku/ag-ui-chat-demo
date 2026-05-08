import { EventType, type BaseEvent } from "@ag-ui/core";

import type { StoredEvent, StoredExtra, StoredStep } from "./store.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

type PersistableStoredEvent = BaseEvent &
  Partial<{
    runId: string;
    messageId: string;
    parentMessageId: string;
    name: string;
    value: unknown;
    role: string;
    delta: string;
    content: string;
    toolCallId: string;
    toolCallName: string;
    step: StoredStep;
    stepName: string;
    extra: StoredExtra;
  }>;

const STORED_EVENT_TYPES = new Set<string>([
  EventType.RUN_STARTED,
  EventType.RUN_FINISHED,
  EventType.STEP_STARTED,
  EventType.STEP_FINISHED,
  EventType.TEXT_MESSAGE_START,
  EventType.TEXT_MESSAGE_CONTENT,
  EventType.TEXT_MESSAGE_CHUNK,
  EventType.TEXT_MESSAGE_END,
  EventType.TOOL_CALL_START,
  EventType.TOOL_CALL_ARGS,
  EventType.TOOL_CALL_END,
  EventType.TOOL_CALL_RESULT,
  EventType.REASONING_START,
  EventType.REASONING_MESSAGE_START,
  EventType.REASONING_MESSAGE_CONTENT,
  EventType.REASONING_MESSAGE_END,
  EventType.REASONING_END,
]);

function isToolResultChunkEvent(event: PersistableStoredEvent) {
  return (
    event.type === EventType.CUSTOM &&
    (event.name === TOOL_RESULT_START_EVENT ||
      event.name === TOOL_RESULT_DELTA_EVENT ||
      event.name === TOOL_RESULT_END_EVENT)
  );
}

function now() {
  return new Date().toISOString();
}

export function toStoredEvents(
  events: BaseEvent[],
  existingCount: number,
): StoredEvent[] {
  const runId = (
    events.find((event) => event.type === EventType.RUN_STARTED) as
      | (PersistableStoredEvent & { runId?: string })
      | undefined
  )?.runId;

  return (events as PersistableStoredEvent[])
    .filter(
      (event) =>
        STORED_EVENT_TYPES.has(event.type) || isToolResultChunkEvent(event),
    )
    .map((event, index) => ({
      type: event.type,
      sequence: existingCount + index,
      createdAt: now(),
      ...(runId ? { runId } : {}),
      ...(event.name ? { name: event.name } : {}),
      ...(event.value !== undefined ? { value: event.value } : {}),
      ...(event.messageId ? { messageId: event.messageId } : {}),
      ...(event.parentMessageId
        ? { parentMessageId: event.parentMessageId }
        : {}),
      ...(event.role ? { role: event.role } : {}),
      ...(event.delta ? { delta: event.delta } : {}),
      ...(event.content ? { content: event.content } : {}),
      ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
      ...(event.toolCallName ? { toolCallName: event.toolCallName } : {}),
      ...(event.step ? { step: event.step } : {}),
      ...(event.stepName ? { stepName: event.stepName } : {}),
      ...(event.extra ? { extra: event.extra } : {}),
    }));
}
