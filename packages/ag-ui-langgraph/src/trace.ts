import { EventType, type BaseEvent } from "@ag-ui/core";

import type { LangGraphStreamEvent, TraceStepKind } from "./types.js";

export const AG_UI_TRACE_EVENT_NAME = "ag-ui.trace";
export const AG_UI_TRACE_PROTOCOL_VERSION = 1;

export type AgUiTraceSource = {
  framework: "langgraph";
  runId?: string;
  nodeName?: string;
  event?: string;
  checkpointNamespace?: string;
};

export type AgUiTraceEvent =
  | {
      type: "span.start";
      spanId: string;
      name: string;
      kind: TraceStepKind;
      parentSpanId?: string;
      source?: AgUiTraceSource;
    }
  | {
      type: "span.end";
      spanId: string;
      source?: AgUiTraceSource;
    }
  | {
      type: "message.link";
      messageId: string;
      spanId: string;
      role?: string;
      source?: AgUiTraceSource;
    }
  | {
      type: "tool.link";
      toolCallId: string;
      spanId: string;
      toolCallName?: string;
      parentMessageId?: string;
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
