import { EventType, type BaseEvent } from "@ag-ui/core";

import type {
  LangGraphStreamEvent,
  RunMetadata,
  TraceStepKind,
} from "../types.js";
import { ROOT_SUBGRAPH_NAME } from "../runtime/stream.js";

export type ActiveTraceSpan = {
  /**
   * Opaque id for one concrete agent instance. This is intentionally not the
   * display name: two concurrent `writer` sub-agents must have different ids.
   */
  agentId: string;
  /** Human-readable agent name (e.g. "writer", "supervisor"). */
  name: string;
  kind: TraceStepKind;
  /**
   * Full LangGraph checkpoint namespace that produced this attribution.
   * The stable agent instance id is derived from the first namespace segment,
   * so internal `agent` / `tools` nodes for the same sub-agent share an id.
   */
  checkpointNamespace?: string;
};

export type TraceState = {
  activeTraceSpan: ActiveTraceSpan | null;
  traceSpanCounters: Map<string, number>;
  /** agentId → agent instance attribution. */
  traceSpans: Map<string, ActiveTraceSpan>;
  /**
   * Full-namespace → agentId index. Used to attribute interleaved events
   * emitted from parallel sub-agent branches.
   */
  traceSpansByNamespace: Map<string, string>;
  /** messageId → owning agentId. */
  traceMessageOwners: Map<string, string>;
  /** toolCallId → owning agentId. */
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
    traceSpanCounters: new Map<string, number>(),
    traceSpans: new Map<string, ActiveTraceSpan>(),
    traceSpansByNamespace: new Map<string, string>(),
    traceMessageOwners: new Map<string, string>(),
    traceToolOwners: new Map<string, string>(),
  };
}

export function resetTraceState(state: TraceState): void {
  state.activeTraceSpan = null;
  state.traceSpanCounters.clear();
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
  const namespaceRoot = getCheckpointNamespaceAgentName(checkpointNamespace);

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

function getCheckpointNamespaceInstanceKey(
  checkpointNamespace?: string,
): string | undefined {
  const segment = checkpointNamespace?.split("|")[0];
  if (!segment) return undefined;
  const name = segment.split(":")[0];
  if (
    !name ||
    name === ROOT_SUBGRAPH_NAME ||
    name === "agent" ||
    name === "tools"
  ) {
    return undefined;
  }
  return segment;
}

function getCheckpointNamespaceAgentName(
  checkpointNamespace?: string,
): string | undefined {
  const instanceKey = getCheckpointNamespaceInstanceKey(checkpointNamespace);
  return instanceKey?.split(":")[0];
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

export function nextTraceAgentId(
  ctx: Pick<TraceStateContext, "activeRun" | "state">,
  stepName: string,
): string {
  const runId = ctx.activeRun?.id ?? "run";
  const key = `${runId}:${stepName}`;
  const next = (ctx.state.traceSpanCounters.get(key) ?? 0) + 1;
  ctx.state.traceSpanCounters.set(key, next);
  return `${runId}:${stepName}:${next}`;
}

export function resolveTraceAgentId(
  ctx: Pick<TraceStateContext, "activeRun" | "currentSubgraph" | "state">,
  stepName: string,
  sourceEvent?: LangGraphStreamEvent | null,
): string {
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);
  const instanceKey = getCheckpointNamespaceInstanceKey(checkpointNamespace);
  const runId = ctx.activeRun?.id ?? "run";

  if (instanceKey) {
    return `${runId}:${instanceKey}`;
  }

  const traceStepName = resolveTraceStepName(ctx, stepName, sourceEvent);
  const active = ctx.state.activeTraceSpan;
  if (active?.name === traceStepName) {
    return active.agentId;
  }

  return `${runId}:${traceStepName}`;
}

/**
 * Resolve which agent instance owns a given source LangGraph event by looking
 * up its checkpoint namespace. Falls back to the currently active instance only
 * if no namespace is available (single-agent / non-subgraph flows).
 *
 * This is the primary mechanism that lets parallel same-name sub-agent
 * branches be distinguished even when their events interleave on the stream.
 */
export function resolveSpanForSource(
  ctx: Pick<TraceStateContext, "activeRun" | "currentSubgraph" | "state">,
  sourceEvent?: LangGraphStreamEvent | null,
): ActiveTraceSpan | null {
  const ns = getCheckpointNamespace(sourceEvent);
  if (ns) {
    const mappedAgentId = ctx.state.traceSpansByNamespace.get(ns);
    if (mappedAgentId) {
      const span = ctx.state.traceSpans.get(mappedAgentId);
      if (span) return span;
    }

    const instanceKey = getCheckpointNamespaceInstanceKey(ns);
    const agentName = getCheckpointNamespaceAgentName(ns);
    if (instanceKey && agentName) {
      const agentId = `${ctx.activeRun?.id ?? "run"}:${instanceKey}`;
      const existing = ctx.state.traceSpans.get(agentId);
      if (existing) {
        ctx.state.traceSpansByNamespace.set(ns, agentId);
        return existing;
      }

      const span: ActiveTraceSpan = {
        agentId,
        name: agentName,
        kind: "subagent",
        checkpointNamespace: ns,
      };
      ctx.state.traceSpans.set(agentId, span);
      ctx.state.traceSpansByNamespace.set(ns, agentId);
      return span;
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
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);
  const instanceKey = getCheckpointNamespaceInstanceKey(checkpointNamespace);
  const agentId = instanceKey
    ? resolveTraceAgentId(ctx, stepName, sourceEvent)
    : ctx.state.activeTraceSpan?.name === traceStepName
      ? ctx.state.activeTraceSpan.agentId
      : nextTraceAgentId(ctx, traceStepName);

  const existing = ctx.state.traceSpans.get(agentId);
  const span: ActiveTraceSpan = existing ?? {
    agentId,
    name: traceStepName,
    kind,
    ...(checkpointNamespace ? { checkpointNamespace } : {}),
  };

  ctx.state.activeTraceSpan = span;
  ctx.state.traceSpans.set(agentId, span);
  if (checkpointNamespace) {
    ctx.state.traceSpansByNamespace.set(checkpointNamespace, agentId);
  }
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

  ctx.state.activeTraceSpan = null;
}

/**
 * Stamp agent attribution onto an in-flight AG-UI protocol event.
 * The frontend reads `agentId`/`agentName` directly from the event — no
 * out-of-band link events are needed. Safe for consumers that do not
 * understand the fields (they are simply ignored).
 */
function stampAgentAttribution(
  event: BaseEvent,
  span: ActiveTraceSpan,
): void {
  const stamped = event as BaseEvent & {
    agentId?: string;
    agentName?: string;
  };
  if (stamped.agentId === undefined) stamped.agentId = span.agentId;
  if (stamped.agentName === undefined) stamped.agentName = span.name;
}

/**
 * Stamp agent attribution on the given AG-UI event (in place). No additional
 * events are emitted — this generator yields nothing. It is kept as a
 * Generator for call-site symmetry with the prior link-emitting API.
 *
 * Attribution resolution priority for each event:
 *   1. owner of referenced messageId (for TEXT_MESSAGE_* / REASONING_*)
 *   2. owner of referenced toolCallId (for TOOL_CALL_RESULT / *_ARGS / *_END)
 *   3. full-namespace lookup against the source LangGraph event
 *   4. currently active span (single-agent fallback)
 *
 * Steps 1–3 make attribution **concurrency-safe**: each sub-agent's events
 * are keyed on stable identifiers that survive event-stream interleaving.
 */
export function* emitTraceLinksForEvent(
  ctx: TraceStateContext,
  event: BaseEvent,
  sourceEvent?: LangGraphStreamEvent | null,
): Generator<BaseEvent> {
  const traceEvent = event as BaseEvent &
    Partial<{
      name: string;
      value: unknown;
      messageId: string;
      parentMessageId: string;
      role: string;
      toolCallId: string;
      toolCallName: string;
    }>;

  const resolveSpan = (
    opts: {
      messageId?: string;
      toolCallId?: string;
    } = {},
  ): ActiveTraceSpan | null => {
    if (opts.messageId) {
      const a = ctx.state.traceMessageOwners.get(opts.messageId);
      if (a) {
        const span = ctx.state.traceSpans.get(a);
        if (span) return span;
      }
    }
    if (opts.toolCallId) {
      const a = ctx.state.traceToolOwners.get(opts.toolCallId);
      if (a) {
        const span = ctx.state.traceSpans.get(a);
        if (span) return span;
      }
    }
    return resolveSpanForSource(ctx, sourceEvent);
  };

  const recordMessageOwner = (
    messageId: string | undefined,
    ownerSpan: ActiveTraceSpan | null,
  ): void => {
    if (!messageId || !ownerSpan) return;
    if (!ctx.state.traceMessageOwners.has(messageId)) {
      ctx.state.traceMessageOwners.set(messageId, ownerSpan.agentId);
    }
    stampAgentAttribution(event, ownerSpan);
  };

  const recordToolOwner = (
    toolCallId: string | undefined,
    ownerSpan: ActiveTraceSpan | null,
  ): void => {
    if (!toolCallId || !ownerSpan) return;
    if (!ctx.state.traceToolOwners.has(toolCallId)) {
      ctx.state.traceToolOwners.set(toolCallId, ownerSpan.agentId);
    }
    stampAgentAttribution(event, ownerSpan);
  };

  if (
    event.type === EventType.TEXT_MESSAGE_START ||
    event.type === EventType.REASONING_START ||
    event.type === EventType.REASONING_MESSAGE_START
  ) {
    const ownerSpan = resolveSpan({ messageId: traceEvent.messageId });
    recordMessageOwner(traceEvent.messageId, ownerSpan);
  }

  if (event.type === EventType.TOOL_CALL_START) {
    // Attribute to the assistant message's owner; parentMessageId is always
    // produced by the same sub-agent that's about to call the tool.
    const ownerSpan =
      resolveSpan({ messageId: traceEvent.parentMessageId }) ?? resolveSpan();
    recordMessageOwner(traceEvent.parentMessageId, ownerSpan);
    recordToolOwner(traceEvent.toolCallId, ownerSpan);
  }

  if (
    event.type === EventType.TOOL_CALL_ARGS ||
    event.type === EventType.TOOL_CALL_END
  ) {
    const ownerSpan =
      resolveSpan({ toolCallId: traceEvent.toolCallId }) ?? resolveSpan();
    if (ownerSpan) stampAgentAttribution(event, ownerSpan);
  }

  if (event.type === EventType.TOOL_CALL_RESULT) {
    const ownerSpan =
      resolveSpan({ toolCallId: traceEvent.toolCallId }) ?? resolveSpan();
    recordMessageOwner(traceEvent.messageId, ownerSpan);
    recordToolOwner(traceEvent.toolCallId, ownerSpan);
  }

  if (
    event.type === EventType.CUSTOM &&
    typeof traceEvent.name === "string" &&
    traceEvent.name.startsWith("ag-ui.tool_result_")
  ) {
    const value = traceEvent.value;
    const customPayload =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as { messageId?: unknown; toolCallId?: unknown })
        : {};
    const messageId =
      typeof customPayload.messageId === "string"
        ? customPayload.messageId
        : undefined;
    const toolCallId =
      typeof customPayload.toolCallId === "string"
        ? customPayload.toolCallId
        : undefined;
    const ownerSpan = resolveSpan({ toolCallId, messageId }) ?? resolveSpan();
    recordMessageOwner(messageId, ownerSpan);
    recordToolOwner(toolCallId, ownerSpan);
  }

  if (
    event.type === EventType.TEXT_MESSAGE_CONTENT ||
    event.type === EventType.TEXT_MESSAGE_END ||
    event.type === EventType.REASONING_END ||
    event.type === EventType.REASONING_MESSAGE_CONTENT ||
    event.type === EventType.REASONING_MESSAGE_END ||
    event.type === EventType.REASONING_MESSAGE_CHUNK
  ) {
    const ownerSpan =
      resolveSpan({ messageId: traceEvent.messageId }) ?? resolveSpan();
    if (ownerSpan) stampAgentAttribution(event, ownerSpan);
  }
}
