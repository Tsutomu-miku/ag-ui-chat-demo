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
} from "../trace.js";
import { ROOT_SUBGRAPH_NAME } from "../runtime/stream.js";
import {
  buildTraceOwnerFromSource,
  type TraceOwnerMetadata,
} from "../runtime/trace-owner.js";

export type ActiveTraceSpan = {
  /**
   * Opaque id for one concrete agent instance. This is intentionally not the
   * display name: two concurrent `writer` sub-agents must have different ids.
   */
  agentId: string;
  spanId: string;
  /** Human-readable agent name (e.g. "writer", "supervisor"). */
  name: string;
  kind: TraceStepKind;
  parentSpanId?: string;
  owner: TraceOwnerMetadata;
  /**
   * Full LangGraph checkpoint namespace that produced this attribution.
   * The stable agent instance id is derived from the first namespace segment,
   * so internal `agent` / `tools` nodes for the same sub-agent share an id.
   */
  checkpointNamespace?: string;
};

export type TraceState = {
  activeTraceSpan: ActiveTraceSpan | null;
  lastSupervisorSpanId?: string;
  lastSupervisorOwnerKey?: string;
  traceSpanCounters: Map<string, number>;
  linkedTraceMessages: Set<string>;
  linkedTraceTools: Set<string>;
  /** agentId → agent instance attribution. */
  traceSpans: Map<string, ActiveTraceSpan>;
  traceOwners: Map<string, TraceOwnerMetadata>;
  traceOwnerSpans: Map<string, string>;
  /**
   * Full-namespace → agentId index. Used to attribute interleaved events
   * emitted from parallel sub-agent branches.
   */
  traceSpansByNamespace: Map<string, string>;
  /** messageId → owning owner key. */
  traceMessageOwners: Map<string, string>;
  /** toolCallId → owning owner key. */
  traceToolOwners: Map<string, string>;
};

export type TraceStateContext = {
  agentName: string;
  traceRunId: string | null;
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
    lastSupervisorOwnerKey: undefined,
    traceSpanCounters: new Map<string, number>(),
    linkedTraceMessages: new Set<string>(),
    linkedTraceTools: new Set<string>(),
    traceSpans: new Map<string, ActiveTraceSpan>(),
    traceOwners: new Map<string, TraceOwnerMetadata>(),
    traceOwnerSpans: new Map<string, string>(),
    traceSpansByNamespace: new Map<string, string>(),
    traceMessageOwners: new Map<string, string>(),
    traceToolOwners: new Map<string, string>(),
  };
}

export function resetTraceState(state: TraceState): void {
  state.activeTraceSpan = null;
  state.lastSupervisorSpanId = undefined;
  state.lastSupervisorOwnerKey = undefined;
  state.traceSpanCounters.clear();
  state.linkedTraceMessages.clear();
  state.linkedTraceTools.clear();
  state.traceSpans.clear();
  state.traceOwners.clear();
  state.traceOwnerSpans.clear();
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
  ctx: Pick<TraceStateContext, "traceRunId" | "activeRun" | "state">,
  stepName: string,
): string {
  const runId = ctx.traceRunId ?? ctx.activeRun?.id ?? "run";
  const key = `${runId}:${stepName}`;
  const next = (ctx.state.traceSpanCounters.get(key) ?? 0) + 1;
  ctx.state.traceSpanCounters.set(key, next);
  return `${runId}:${stepName}:${next}`;
}

function nextTraceSpanId(
  ctx: Pick<TraceStateContext, "traceRunId" | "activeRun" | "state">,
  stepName: string,
): string {
  const runId = ctx.traceRunId ?? ctx.activeRun?.id ?? "run";
  const key = `${runId}:${stepName}:span`;
  const next = (ctx.state.traceSpanCounters.get(key) ?? 0) + 1;
  ctx.state.traceSpanCounters.set(key, next);
  return `${runId}:${stepName}:${next}`;
}

export function emitTraceEvent(
  ctx: Pick<TraceStateContext, "dispatchEvent">,
  event: AgUiTraceEvent,
): BaseEvent | null {
  return ctx.dispatchEvent(createTraceCustomEvent(event));
}

export function buildTraceSource(
  ctx: Pick<TraceStateContext, "traceRunId" | "activeRun">,
  nodeName?: string | null,
  event?: LangGraphStreamEvent | null,
): AgUiTraceSource {
  return traceSourceFromLangGraphEvent({
    runId: ctx.traceRunId ?? ctx.activeRun?.id,
    nodeName: nodeName ?? undefined,
    event: event ?? null,
  });
}

function toTraceOwner(owner: TraceOwnerMetadata) {
  return {
    key: owner.key,
    type: owner.type,
    instanceId: owner.instanceId,
    ...(owner.parentKey ? { parentKey: owner.parentKey } : {}),
  };
}

export function resolveTraceAgentId(
  ctx: Pick<
    TraceStateContext,
    "traceRunId" | "activeRun" | "currentSubgraph" | "state"
  >,
  stepName: string,
  sourceEvent?: LangGraphStreamEvent | null,
): string {
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);
  const instanceKey = getCheckpointNamespaceInstanceKey(checkpointNamespace);
  const runId = ctx.traceRunId ?? ctx.activeRun?.id ?? "run";

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
  ctx: Pick<
    TraceStateContext,
    "traceRunId" | "activeRun" | "currentSubgraph" | "state"
  >,
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
      const agentId = `${ctx.traceRunId ?? ctx.activeRun?.id ?? "run"}:${instanceKey}`;
      const existing = ctx.state.traceSpans.get(agentId);
      if (existing) {
        ctx.state.traceSpansByNamespace.set(ns, agentId);
        return existing;
      }

      const owner = buildTraceOwnerFromSource({
        runId: ctx.traceRunId ?? ctx.activeRun?.id,
        stepName: agentName,
        kind: "subagent",
        event: sourceEvent,
        owner: ctx.state.lastSupervisorOwnerKey
          ? { parentKey: ctx.state.lastSupervisorOwnerKey }
          : undefined,
      });
      const span: ActiveTraceSpan = {
        agentId,
        spanId: nextTraceSpanId(ctx, agentName),
        name: agentName,
        kind: "subagent",
        owner,
        ...(ctx.state.lastSupervisorSpanId
          ? { parentSpanId: ctx.state.lastSupervisorSpanId }
          : {}),
        checkpointNamespace: ns,
      };
      ctx.state.traceSpans.set(agentId, span);
      ctx.state.traceOwners.set(owner.key, owner);
      ctx.state.traceOwnerSpans.set(owner.key, agentId);
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
  const parentSpanId =
    kind === "subagent" ? ctx.state.lastSupervisorSpanId : undefined;
  const owner = buildTraceOwnerFromSource({
    runId: ctx.traceRunId ?? ctx.activeRun?.id,
    stepName: traceStepName,
    kind,
    event: sourceEvent,
    owner: ctx.state.lastSupervisorOwnerKey
      ? kind === "subagent"
        ? { parentKey: ctx.state.lastSupervisorOwnerKey }
        : undefined
      : undefined,
  });

  const existing = ctx.state.traceSpans.get(agentId);
  if (existing && existing.owner.key === owner.key) {
    ctx.state.activeTraceSpan = existing;
    ctx.state.traceOwners.set(owner.key, owner);
    ctx.state.traceOwnerSpans.set(owner.key, agentId);
    if (checkpointNamespace) {
      ctx.state.traceSpansByNamespace.set(checkpointNamespace, agentId);
    }
    return;
  }

  const span: ActiveTraceSpan = {
    agentId,
    spanId: nextTraceSpanId(ctx, traceStepName),
    name: traceStepName,
    kind,
    ...(parentSpanId ? { parentSpanId } : {}),
    owner,
    ...(checkpointNamespace ? { checkpointNamespace } : {}),
  };

  ctx.state.activeTraceSpan = span;
  ctx.state.traceSpans.set(agentId, span);
  ctx.state.traceOwners.set(owner.key, owner);
  ctx.state.traceOwnerSpans.set(owner.key, agentId);
  if (checkpointNamespace) {
    ctx.state.traceSpansByNamespace.set(checkpointNamespace, agentId);
  }

  if (kind === "supervisor") {
    ctx.state.lastSupervisorSpanId = span.spanId;
    ctx.state.lastSupervisorOwnerKey = span.owner.key;
  }

  const traceEvent = emitTraceEvent(ctx, {
    type: "span.start",
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
    owner: toTraceOwner(span.owner),
    source: buildTraceSource(ctx, traceStepName, sourceEvent),
  });
  if (traceEvent) yield traceEvent;
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

  const traceEvent = emitTraceEvent(ctx, {
    type: "span.end",
    spanId: span.spanId,
    owner: toTraceOwner(span.owner),
    source: buildTraceSource(ctx, traceStepName, sourceEvent),
  });
  if (traceEvent) yield traceEvent;

  ctx.state.activeTraceSpan = null;
}

/**
 * Stamp agent attribution onto an in-flight AG-UI protocol event.
 * The frontend reads `agentId`/`agentName` directly from the event — no
 * out-of-band link events are needed. Safe for consumers that do not
 * understand the fields (they are simply ignored).
 */
function stampAgentAttribution(event: BaseEvent, span: ActiveTraceSpan): void {
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
      owner: {
        key: string;
        type?: string;
        instanceId?: string;
        parentKey?: string;
      };
    }>;

  const resolveSpan = (
    opts: {
      messageId?: string;
      toolCallId?: string;
      owner?: {
        key: string;
      };
    } = {},
  ): ActiveTraceSpan | null => {
    if (opts.owner?.key) {
      const agentId = ctx.state.traceOwnerSpans.get(opts.owner.key);
      if (agentId) {
        const span = ctx.state.traceSpans.get(agentId);
        if (span) return span;
      }
    }
    if (opts.messageId) {
      const ownerKey = ctx.state.traceMessageOwners.get(opts.messageId);
      if (ownerKey) {
        const agentId = ctx.state.traceOwnerSpans.get(ownerKey);
        const span = agentId ? ctx.state.traceSpans.get(agentId) : undefined;
        if (span) return span;
      }
    }
    if (opts.toolCallId) {
      const ownerKey = ctx.state.traceToolOwners.get(opts.toolCallId);
      if (ownerKey) {
        const agentId = ctx.state.traceOwnerSpans.get(ownerKey);
        const span = agentId ? ctx.state.traceSpans.get(agentId) : undefined;
        if (span) return span;
      }
    }
    return resolveSpanForSource(ctx, sourceEvent);
  };

  const recordMessageOwner = (
    messageId: string | undefined,
    ownerSpan: ActiveTraceSpan | null,
    role?: string,
  ): void => {
    if (!messageId || !ownerSpan) return;
    const isNewLink = !ctx.state.linkedTraceMessages.has(messageId);
    ctx.state.traceMessageOwners.set(messageId, ownerSpan.owner.key);
    stampAgentAttribution(event, ownerSpan);
    if (!isNewLink) return;
    ctx.state.linkedTraceMessages.add(messageId);

    const traceEvent = emitTraceEvent(ctx, {
      type: "message.link",
      messageId,
      spanId: ownerSpan.spanId,
      ...(role ? { role } : {}),
      owner: toTraceOwner(ownerSpan.owner),
      source: buildTraceSource(ctx, ownerSpan.name, sourceEvent),
    });
    if (traceEvent) {
      emittedEvents.push(traceEvent);
    }
  };

  const recordToolOwner = (
    toolCallId: string | undefined,
    ownerSpan: ActiveTraceSpan | null,
    parentMessageId?: string,
    toolCallName?: string,
  ): void => {
    if (!toolCallId || !ownerSpan) return;
    const isNewLink = !ctx.state.linkedTraceTools.has(toolCallId);
    ctx.state.traceToolOwners.set(toolCallId, ownerSpan.owner.key);
    stampAgentAttribution(event, ownerSpan);
    if (!isNewLink) return;
    ctx.state.linkedTraceTools.add(toolCallId);

    const traceEvent = emitTraceEvent(ctx, {
      type: "tool.link",
      toolCallId,
      spanId: ownerSpan.spanId,
      ...(toolCallName ? { toolCallName } : {}),
      ...(parentMessageId ? { parentMessageId } : {}),
      owner: toTraceOwner(ownerSpan.owner),
      source: buildTraceSource(ctx, ownerSpan.name, sourceEvent),
    });
    if (traceEvent) {
      emittedEvents.push(traceEvent);
    }
  };

  const emittedEvents: BaseEvent[] = [];

  if (
    event.type === EventType.TEXT_MESSAGE_START ||
    event.type === EventType.REASONING_START ||
    event.type === EventType.REASONING_MESSAGE_START
  ) {
    const ownerSpan = resolveSpan({
      messageId: traceEvent.messageId,
      owner: traceEvent.owner,
    });
    recordMessageOwner(traceEvent.messageId, ownerSpan, traceEvent.role);
  }

  if (event.type === EventType.TOOL_CALL_START) {
    const ownerKey =
      traceEvent.owner?.key ??
      (traceEvent.parentMessageId
        ? ctx.state.traceMessageOwners.get(traceEvent.parentMessageId)
        : undefined);
    const ownerSpan =
      resolveSpan({
        messageId: traceEvent.parentMessageId,
        owner: ownerKey ? { key: ownerKey } : undefined,
      }) ?? resolveSpan();
    recordMessageOwner(traceEvent.parentMessageId, ownerSpan, "assistant");
    recordToolOwner(
      traceEvent.toolCallId,
      ownerSpan,
      traceEvent.parentMessageId,
      traceEvent.toolCallName,
    );
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
    const ownerKey =
      traceEvent.owner?.key ??
      (traceEvent.toolCallId
        ? ctx.state.traceToolOwners.get(traceEvent.toolCallId)
        : undefined);
    const ownerSpan =
      resolveSpan({
        toolCallId: traceEvent.toolCallId,
        owner: ownerKey ? { key: ownerKey } : undefined,
      }) ?? resolveSpan();
    recordMessageOwner(traceEvent.messageId, ownerSpan, "tool");
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

  yield* emittedEvents;
}
