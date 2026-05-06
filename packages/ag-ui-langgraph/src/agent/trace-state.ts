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
  /**
   * Full LangGraph checkpoint namespace that owns this span (e.g.
   * `writer:subgraph|agent:3f2a`). Retained for resolving ownership of
   * interleaved events from parallel sub-agent branches.
   */
  checkpointNamespace?: string;
};

export type TraceState = {
  activeTraceSpan: ActiveTraceSpan | null;
  lastSupervisorSpanId?: string;
  traceSpanCounters: Map<string, number>;
  linkedTraceMessages: Set<string>;
  linkedTraceTools: Set<string>;
  traceSpans: Map<string, ActiveTraceSpan>;
  /**
   * Full-namespace → spanId index. Used to attribute events emitted from
   * parallel sub-agent branches whose root name collides but whose uuid
   * suffix differs (`writer:subgraph|agent:aaa` vs `writer:subgraph|agent:bbb`).
   */
  traceSpansByNamespace: Map<string, string>;
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
    traceSpansByNamespace: new Map<string, string>(),
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
  state.traceSpansByNamespace.clear();
  state.traceMessageOwners.clear();
  state.traceToolOwners.clear();
}

/** Returns the full `langgraph_checkpoint_ns` string if present. */
export function getCheckpointNamespace(
  sourceEvent?: LangGraphStreamEvent | null,
): string | undefined {
  const checkpointNamespace =
    typeof sourceEvent?.metadata?.langgraph_checkpoint_ns === "string"
      ? sourceEvent.metadata.langgraph_checkpoint_ns
      : undefined;
  return checkpointNamespace && checkpointNamespace.length > 0
    ? checkpointNamespace
    : undefined;
}

export function getTraceNamespaceRoot(
  sourceEvent?: LangGraphStreamEvent | null,
): string | undefined {
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);
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

/**
 * Resolve which span owns a given source LangGraph event by looking up its
 * full checkpoint namespace. Falls back to the currently active span only if
 * no namespace is available (single-agent / non-subgraph flows).
 *
 * This is the primary mechanism that lets parallel sub-agent branches be
 * distinguished even when their events interleave on the stream.
 */
export function resolveSpanForSource(
  ctx: Pick<TraceStateContext, "state">,
  sourceEvent?: LangGraphStreamEvent | null,
): ActiveTraceSpan | null {
  const ns = getCheckpointNamespace(sourceEvent);
  if (ns) {
    const spanId = ctx.state.traceSpansByNamespace.get(ns);
    if (spanId) {
      const span = ctx.state.traceSpans.get(spanId);
      if (span) return span;
    }
  }
  return ctx.state.activeTraceSpan;
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
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);

  const span: ActiveTraceSpan = {
    spanId,
    name: traceStepName,
    kind,
    ...(parentSpanId ? { parentSpanId } : {}),
    ...(checkpointNamespace ? { checkpointNamespace } : {}),
  };

  ctx.state.activeTraceSpan = span;
  ctx.state.traceSpans.set(spanId, span);
  if (checkpointNamespace) {
    ctx.state.traceSpansByNamespace.set(checkpointNamespace, spanId);
  }

  if (kind === "supervisor") {
    ctx.state.lastSupervisorSpanId = spanId;
  }

  yield* emitTraceEvent(ctx, {
    type: "span.start",
    spanId,
    agentId: spanId,
    agentName: traceStepName,
    name: traceStepName,
    kind,
    ...(parentSpanId
      ? { parentSpanId, parentAgentId: parentSpanId }
      : {}),
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
    agentId: span.spanId,
    source: buildTraceSource(ctx, traceStepName, sourceEvent),
  });

  ctx.state.activeTraceSpan = null;
}

/**
 * Stamp agent attribution onto an in-flight AG-UI protocol event.
 * The frontend can read `agentId`/`agentName` directly from the event, without
 * needing to join a separate trace link. Safe even for consumers that do not
 * understand the additional fields (they are simply ignored).
 */
function stampAgentAttribution(
  event: BaseEvent,
  span: ActiveTraceSpan,
): void {
  const stamped = event as BaseEvent & {
    agentId?: string;
    agentName?: string;
    spanId?: string;
  };
  if (stamped.agentId === undefined) stamped.agentId = span.spanId;
  if (stamped.agentName === undefined) stamped.agentName = span.name;
  if (stamped.spanId === undefined) stamped.spanId = span.spanId;
}

export function* emitTraceLinksForEvent(
  ctx: TraceStateContext,
  event: BaseEvent,
  sourceEvent?: LangGraphStreamEvent | null,
): Generator<BaseEvent> {
  const traceEvent = event as BaseEvent &
    Partial<{
      messageId: string;
      parentMessageId: string;
      role: string;
      toolCallId: string;
      toolCallName: string;
    }>;

  /**
   * Resolve a span for a specific link. Priority:
   *   1. explicit spanId override (already-attributed case)
   *   2. owner of a referenced messageId (same span the assistant message lives in)
   *   3. owner of a referenced toolCallId (for TOOL_CALL_RESULT attribution)
   *   4. full-namespace lookup against the source LangGraph event
   *   5. currently active span (legacy single-agent fallback)
   *
   * Steps 2–4 make attribution **concurrency-safe**: each sub-agent's events
   * are keyed on stable identifiers that survive event-stream interleaving.
   */
  const resolveSpan = (
    opts: {
      spanId?: string;
      messageId?: string;
      toolCallId?: string;
    } = {},
  ): ActiveTraceSpan | null => {
    if (opts.spanId) {
      return ctx.state.traceSpans.get(opts.spanId) ?? null;
    }
    if (opts.messageId) {
      const s = ctx.state.traceMessageOwners.get(opts.messageId);
      if (s) {
        const span = ctx.state.traceSpans.get(s);
        if (span) return span;
      }
    }
    if (opts.toolCallId) {
      const s = ctx.state.traceToolOwners.get(opts.toolCallId);
      if (s) {
        const span = ctx.state.traceSpans.get(s);
        if (span) return span;
      }
    }
    return resolveSpanForSource(ctx, sourceEvent);
  };

  const linkMessage = function* (
    messageId: string | undefined,
    role?: string,
    ownerSpan?: ActiveTraceSpan | null,
  ): Generator<BaseEvent> {
    if (!messageId || !ownerSpan) return;
    if (ctx.state.linkedTraceMessages.has(messageId)) {
      // Still (re-)stamp on pass-through events so every downstream copy
      // carries attribution even if the canonical link was emitted earlier.
      stampAgentAttribution(event, ownerSpan);
      return;
    }
    ctx.state.linkedTraceMessages.add(messageId);
    ctx.state.traceMessageOwners.set(messageId, ownerSpan.spanId);
    stampAgentAttribution(event, ownerSpan);
    yield* emitTraceEvent(ctx, {
      type: "message.link",
      messageId,
      spanId: ownerSpan.spanId,
      agentId: ownerSpan.spanId,
      agentName: ownerSpan.name,
      ...(role ? { role } : {}),
      source: buildTraceSource(ctx, ownerSpan.name, sourceEvent),
    });
  };

  const linkTool = function* (
    toolCallId: string | undefined,
    opts: {
      toolCallName?: string;
      parentMessageId?: string;
      ownerSpan?: ActiveTraceSpan | null;
    } = {},
  ): Generator<BaseEvent> {
    if (!toolCallId) return;

    const ownerSpan = opts.ownerSpan ?? null;
    if (!ownerSpan) return;

    if (ctx.state.linkedTraceTools.has(toolCallId)) {
      stampAgentAttribution(event, ownerSpan);
      return;
    }

    ctx.state.linkedTraceTools.add(toolCallId);
    ctx.state.traceToolOwners.set(toolCallId, ownerSpan.spanId);
    stampAgentAttribution(event, ownerSpan);
    yield* emitTraceEvent(ctx, {
      type: "tool.link",
      toolCallId,
      spanId: ownerSpan.spanId,
      agentId: ownerSpan.spanId,
      agentName: ownerSpan.name,
      ...(opts.toolCallName ? { toolCallName: opts.toolCallName } : {}),
      ...(opts.parentMessageId
        ? { parentMessageId: opts.parentMessageId }
        : {}),
      source: buildTraceSource(ctx, ownerSpan.name, sourceEvent),
    });
  };

  if (
    event.type === EventType.TEXT_MESSAGE_START ||
    event.type === EventType.REASONING_START ||
    event.type === EventType.REASONING_MESSAGE_START
  ) {
    // Prefer the source event's full namespace so parallel branches win over
    // whichever sub-agent span happens to be "active" right now.
    const ownerSpan = resolveSpan({
      messageId: traceEvent.messageId,
    });
    yield* linkMessage(
      traceEvent.messageId,
      traceEvent.role ?? "assistant",
      ownerSpan,
    );
  }

  if (event.type === EventType.TOOL_CALL_START) {
    // Attribute to the assistant message's owner; parentMessageId is always
    // produced by the same sub-agent that's about to call the tool.
    const ownerSpan =
      resolveSpan({ messageId: traceEvent.parentMessageId }) ??
      resolveSpan({});
    yield* linkMessage(traceEvent.parentMessageId, "assistant", ownerSpan);
    yield* linkTool(traceEvent.toolCallId, {
      toolCallName: traceEvent.toolCallName,
      parentMessageId: traceEvent.parentMessageId,
      ownerSpan,
    });
  }

  // Stamp TOOL_CALL_ARGS / TOOL_CALL_END as they flow through so downstream
  // consumers don't need to thread parentMessageId themselves.
  if (
    event.type === EventType.TOOL_CALL_ARGS ||
    event.type === EventType.TOOL_CALL_END
  ) {
    const ownerSpan =
      resolveSpan({ toolCallId: traceEvent.toolCallId }) ?? resolveSpan({});
    if (ownerSpan) stampAgentAttribution(event, ownerSpan);
  }

  if (event.type === EventType.TOOL_CALL_RESULT) {
    const ownerSpan =
      resolveSpan({ toolCallId: traceEvent.toolCallId }) ?? resolveSpan({});
    yield* linkMessage(traceEvent.messageId, "tool", ownerSpan);
    yield* linkTool(traceEvent.toolCallId, {
      ownerSpan,
    });
  }

  // For TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END / REASONING_* follow-ups,
  // stamp attribution as well so every chunk of the same logical message
  // carries its agentId.
  if (
    event.type === EventType.TEXT_MESSAGE_CONTENT ||
    event.type === EventType.TEXT_MESSAGE_END ||
    event.type === EventType.REASONING_END ||
    event.type === EventType.REASONING_MESSAGE_CONTENT ||
    event.type === EventType.REASONING_MESSAGE_END ||
    event.type === EventType.REASONING_MESSAGE_CHUNK
  ) {
    const ownerSpan =
      resolveSpan({ messageId: traceEvent.messageId }) ?? resolveSpan({});
    if (ownerSpan) stampAgentAttribution(event, ownerSpan);
  }
}
