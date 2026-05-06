import { EventType, type BaseEvent } from "@ag-ui/core";
import { AG_UI_TRACE_EVENT_NAME } from "ag-ui-langgraph";

import type { StoredTraceEvent } from "./store.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

type PersistableTraceEvent = BaseEvent &
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
    stepId: string;
    parentStepId: string;
    stepKind: string;
    stepName: string;
    parentStepName: string;
    agentId: string;
    agentName: string;
  }>;

const TRACE_EVENT_TYPES = new Set<string>([
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

function isCanonicalTraceEvent(event: PersistableTraceEvent) {
  return (
    event.type === EventType.CUSTOM && event.name === AG_UI_TRACE_EVENT_NAME
  );
}

function isToolResultChunkEvent(event: PersistableTraceEvent) {
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

export function toStoredTraceEvents(
  events: BaseEvent[],
  existingCount: number,
): StoredTraceEvent[] {
  const runId = (
    events.find((event) => event.type === EventType.RUN_STARTED) as
      | (PersistableTraceEvent & { runId?: string })
      | undefined
  )?.runId;

  return (events as PersistableTraceEvent[])
    .filter(
      (event) =>
        TRACE_EVENT_TYPES.has(event.type) ||
        isCanonicalTraceEvent(event) ||
        isToolResultChunkEvent(event),
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
      ...(event.stepId ? { stepId: event.stepId } : {}),
      ...(event.parentStepId ? { parentStepId: event.parentStepId } : {}),
      ...(event.stepKind ? { stepKind: event.stepKind } : {}),
      ...(event.stepName ? { stepName: event.stepName } : {}),
      ...(event.parentStepName ? { parentStepName: event.parentStepName } : {}),
      ...(event.agentId ? { agentId: event.agentId } : {}),
      ...(event.agentName ? { agentName: event.agentName } : {}),
    }));
}
