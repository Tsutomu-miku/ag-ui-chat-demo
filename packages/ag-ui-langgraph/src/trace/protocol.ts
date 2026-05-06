import { EventType, type BaseEvent } from "@ag-ui/core";

import type { LangGraphStreamEvent, TraceStepKind } from "../types.js";

export const AG_UI_TRACE_EVENT_NAME = "ag-ui.trace";
export const AG_UI_TRACE_PROTOCOL_VERSION = 2;

export type AgUiTraceSource = {
  framework: "langgraph";
  runId?: string;
  nodeName?: string;
  event?: string;
  checkpointNamespace?: string;
};

/**
 * AG-UI trace protocol — span boundaries only.
 *
 * Per-event attribution (which agent produced a `TEXT_MESSAGE_*` /
 * `TOOL_CALL_*` / `REASONING_*` event) is carried directly on the event
 * itself via `agentId` / `agentName`. We no longer emit `message.link` or
 * `tool.link` events — they were redundant once attribution travels in-band.
 */
export type AgUiTraceEvent =
  | {
      type: "span.start";
      /** Canonical agent id for the span. Stable across the whole run. */
      agentId: string;
      /** Human-readable agent/step name (e.g. "writer", "supervisor"). */
      agentName: string;
      kind: TraceStepKind;
      /** Parent agent id (supervisor for a sub-agent), if any. */
      parentAgentId?: string;
      source?: AgUiTraceSource;
    }
  | {
      type: "span.end";
      agentId: string;
      source?: AgUiTraceSource;
    };

export type AgUiTraceCustomValue = AgUiTraceEvent & {
  version: typeof AG_UI_TRACE_PROTOCOL_VERSION;
};

export type AgUiTraceCustomEvent = BaseEvent & {
  type: EventType.CUSTOM;
  name: typeof AG_UI_TRACE_EVENT_NAME;
  value: AgUiTraceCustomValue;
};

export function createTraceCustomEvent(
  event: AgUiTraceEvent,
): AgUiTraceCustomEvent {
  return {
    type: EventType.CUSTOM,
    name: AG_UI_TRACE_EVENT_NAME,
    value: {
      version: AG_UI_TRACE_PROTOCOL_VERSION,
      ...event,
    },
  } as AgUiTraceCustomEvent;
}

export function traceSourceFromLangGraphEvent(opts: {
  runId?: string;
  nodeName?: string;
  event?: LangGraphStreamEvent | null;
}): AgUiTraceSource {
  const metadata = opts.event?.metadata ?? {};
  const checkpointNamespace =
    typeof metadata.langgraph_checkpoint_ns === "string"
      ? metadata.langgraph_checkpoint_ns
      : undefined;

  return {
    framework: "langgraph",
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.nodeName ? { nodeName: opts.nodeName } : {}),
    ...(opts.event?.event ? { event: opts.event.event } : {}),
    ...(checkpointNamespace ? { checkpointNamespace } : {}),
  };
}
