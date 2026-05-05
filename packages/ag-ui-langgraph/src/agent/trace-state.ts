import { EventType, type BaseEvent } from "@ag-ui/core";

import type {
  LangGraphStreamEvent,
  RunMetadata,
  TraceStepKind,
} from "../types.js";
import {
  createTraceCustomEvent,
  traceSourceFromLangGraphEvent,
  type AgUiTraceEvent,
  type AgUiTraceSource,
} from "../trace/protocol.js";
import { ROOT_SUBGRAPH_NAME } from "../runtime/stream.js";

export type ActiveTraceSpan = {
  spanId: string;
  name: string;
  kind: TraceStepKind;
  parentSpanId?: string;
};

export type TraceState = {
  activeTraceSpan: ActiveTraceSpan | null;
  lastSupervisorSpanId?: string;
  traceSpanCounters: Map<string, number>;
  linkedTraceMessages: Set<string>;
  linkedTraceTools: Set<string>;
  traceSpans: Map<string, ActiveTraceSpan>;
  traceMessageOwners: Map<string, string>;
  traceToolOwners: Map<string, string>;
};

export type TraceStateContext = {
  agentName: string;
  activeRun: RunMetadata | null;
  currentSubgraph: string;
  subgraphs: Set<string>;
  traceSubAgents: Set<string>;
  state: TraceState;
  dispatchEvent: (event: BaseEvent) => BaseEvent | null;
};

export function createTraceState(): TraceState {
  return {
    activeTraceSpan: null,
    lastSupervisorSpanId: undefined,
    traceSpanCounters: new Map<string, number>(),
    linkedTraceMessages: new Set<string>(),
    linkedTraceTools: new Set<string>(),
    traceSpans: new Map<string, ActiveTraceSpan>(),
    traceMessageOwners: new Map<string, string>(),
    traceToolOwners: new Map<string, string>(),
  };
}

export function resetTraceState(state: TraceState): void {
  state.activeTraceSpan = null;
  state.lastSupervisorSpanId = undefined;
  state.traceSpanCounters.clear();
  state.linkedTraceMessages.clear();
  state.linkedTraceTools.clear();
  state.traceSpans.clear();
  state.traceMessageOwners.clear();
  state.traceToolOwners.clear();
}

export function getTraceNamespaceRoot(
  sourceEvent?: LangGraphStreamEvent | null,
): string | undefined {
  const checkpointNamespace =
    typeof sourceEvent?.metadata?.langgraph_checkpoint_ns === "string"
      ? sourceEvent.metadata.langgraph_checkpoint_ns
      : undefined;
  const namespaceRoot = checkpointNamespace?.split("|")[0]?.split(":")[0];

  if (
    !namespaceRoot ||
    namespaceRoot === ROOT_SUBGRAPH_NAME ||
    namespaceRoot === "agent" ||
    namespaceRoot === "tools"
  ) {
    return undefined;
  }

  return namespaceRoot;
}

export function resolveTraceStepName(
  ctx: Pick<TraceStateContext, "currentSubgraph">,
  stepName: string,
  sourceEvent?: LangGraphStreamEvent | null,
): string {
  return (
    getTraceNamespaceRoot(sourceEvent) ||
    (ctx.currentSubgraph !== ROOT_SUBGRAPH_NAME
      ? ctx.currentSubgraph
      : undefined) ||
    stepName
  );
}

export function classifyTraceStepKind(
  ctx: Pick<TraceStateContext, "agentName" | "traceSubAgents" | "subgraphs">,
  stepName: string,
): TraceStepKind {
  if (stepName === ctx.agentName || stepName === "supervisor") {
    return "supervisor";
  }

  if (ctx.traceSubAgents.has(stepName) || ctx.subgraphs.has(stepName)) {
    return "subagent";
  }

  return "node";
}

export function nextTraceSpanId(
  ctx: Pick<TraceStateContext, "activeRun" | "state">,
  stepName: string,
): string {
  const runId = ctx.activeRun?.id ?? "run";
  const key = `${runId}:${stepName}`;
  const next = (ctx.state.traceSpanCounters.get(key) ?? 0) + 1;
  ctx.state.traceSpanCounters.set(key, next);
  return `${runId}:${stepName}:${next}`;
}

export function* emitTraceEvent(
  ctx: Pick<TraceStateContext, "dispatchEvent">,
  event: AgUiTraceEvent,
): Generator<BaseEvent> {
  const ev = ctx.dispatchEvent(createTraceCustomEvent(event));
  if (ev) yield ev;
}

export function buildTraceSource(
  ctx: Pick<TraceStateContext, "activeRun">,
  nodeName?: string | null,
  event?: LangGraphStreamEvent | null,
): AgUiTraceSource {
  return traceSourceFromLangGraphEvent({
    runId: ctx.activeRun?.id,
    nodeName: nodeName ?? undefined,
    event: event ?? null,
  });
}

export function* startTraceSpan(
  ctx: TraceStateContext,
  stepName: string,
  sourceEvent?: LangGraphStreamEvent | null,
): Generator<BaseEvent> {
  const traceStepName = resolveTraceStepName(ctx, stepName, sourceEvent);
  const kind = classifyTraceStepKind(ctx, traceStepName);
  const spanId = nextTraceSpanId(ctx, traceStepName);
  const parentSpanId =
    kind === "subagent" ? ctx.state.lastSupervisorSpanId : undefined;

  ctx.state.activeTraceSpan = {
    spanId,
    name: traceStepName,
    kind,
    ...(parentSpanId ? { parentSpanId } : {}),
  };
  ctx.state.traceSpans.set(spanId, ctx.state.activeTraceSpan);

  if (kind === "supervisor") {
    ctx.state.lastSupervisorSpanId = spanId;
  }

  yield* emitTraceEvent(ctx, {
    type: "span.start",
    spanId,
    name: traceStepName,
    kind,
    ...(parentSpanId ? { parentSpanId } : {}),
    source: buildTraceSource(ctx, traceStepName, sourceEvent),
  });
}

export function* finishTraceSpan(
  ctx: TraceStateContext,
  stepName: string,
  sourceEvent?: LangGraphStreamEvent | null,
): Generator<BaseEvent> {
  const span = ctx.state.activeTraceSpan;
  if (!span) return;
  const traceStepName =
    stepName === span.name
      ? stepName
      : resolveTraceStepName(ctx, stepName, sourceEvent);
  if (span.name !== traceStepName) return;

  yield* emitTraceEvent(ctx, {
    type: "span.end",
    spanId: span.spanId,
    source: buildTraceSource(ctx, traceStepName, sourceEvent),
  });

  ctx.state.activeTraceSpan = null;
}

export function* emitTraceLinksForEvent(
  ctx: TraceStateContext,
  event: BaseEvent,
  sourceEvent?: LangGraphStreamEvent | null,
): Generator<BaseEvent> {
  const activeSpan = ctx.state.activeTraceSpan;
  const traceEvent = event as BaseEvent &
    Partial<{
      messageId: string;
      parentMessageId: string;
      role: string;
      toolCallId: string;
      toolCallName: string;
    }>;

  const resolveSpan = (spanId?: string): ActiveTraceSpan | null => {
    if (!spanId) return activeSpan;
    return ctx.state.traceSpans.get(spanId) ?? activeSpan ?? null;
  };

  const linkMessage = function* (
    messageId: string | undefined,
    role?: string,
    spanId?: string,
  ): Generator<BaseEvent> {
    const span = resolveSpan(spanId);
    if (!messageId || ctx.state.linkedTraceMessages.has(messageId) || !span) {
      return;
    }
    ctx.state.linkedTraceMessages.add(messageId);
    ctx.state.traceMessageOwners.set(messageId, span.spanId);
    yield* emitTraceEvent(ctx, {
      type: "message.link",
      messageId,
      spanId: span.spanId,
      ...(role ? { role } : {}),
      source: buildTraceSource(ctx, span.name, sourceEvent),
    });
  };

  const linkTool = function* (
    toolCallId: string | undefined,
    opts: {
      toolCallName?: string;
      parentMessageId?: string;
      spanId?: string;
    } = {},
  ): Generator<BaseEvent> {
    if (!toolCallId || ctx.state.linkedTraceTools.has(toolCallId)) return;

    const ownedSpanId =
      opts.spanId ??
      (opts.parentMessageId
        ? ctx.state.traceMessageOwners.get(opts.parentMessageId)
        : undefined) ??
      ctx.state.traceToolOwners.get(toolCallId);
    const span = resolveSpan(ownedSpanId);
    if (!span) return;

    ctx.state.linkedTraceTools.add(toolCallId);
    ctx.state.traceToolOwners.set(toolCallId, span.spanId);
    yield* emitTraceEvent(ctx, {
      type: "tool.link",
      toolCallId,
      spanId: span.spanId,
      ...(opts.toolCallName ? { toolCallName: opts.toolCallName } : {}),
      ...(opts.parentMessageId
        ? { parentMessageId: opts.parentMessageId }
        : {}),
      source: buildTraceSource(ctx, span.name, sourceEvent),
    });
  };

  if (
    event.type === EventType.TEXT_MESSAGE_START ||
    event.type === EventType.REASONING_START ||
    event.type === EventType.REASONING_MESSAGE_START
  ) {
    yield* linkMessage(
      traceEvent.messageId,
      traceEvent.role ?? "assistant",
      ctx.state.traceMessageOwners.get(traceEvent.messageId ?? ""),
    );
  }

  if (event.type === EventType.TOOL_CALL_START) {
    const ownerSpanId = traceEvent.parentMessageId
      ? ctx.state.traceMessageOwners.get(traceEvent.parentMessageId)
      : undefined;
    yield* linkMessage(traceEvent.parentMessageId, "assistant", ownerSpanId);
    yield* linkTool(traceEvent.toolCallId, {
      toolCallName: traceEvent.toolCallName,
      parentMessageId: traceEvent.parentMessageId,
      spanId: ownerSpanId,
    });
  }

  if (event.type === EventType.TOOL_CALL_RESULT) {
    const ownerSpanId = traceEvent.toolCallId
      ? ctx.state.traceToolOwners.get(traceEvent.toolCallId)
      : undefined;
    yield* linkMessage(traceEvent.messageId, "tool", ownerSpanId);
    yield* linkTool(traceEvent.toolCallId, {
      spanId: ownerSpanId,
    });
  }
}
