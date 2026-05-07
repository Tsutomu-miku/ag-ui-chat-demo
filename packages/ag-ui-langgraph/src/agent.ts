/**
 * LangGraphAgent — AG-UI protocol adapter for LangGraph compiled graphs.
 *
 * **Fully aligned with Python `ag_ui_langgraph.LangGraphAgent` v0.0.34:**
 * - Accepts a compiled LangGraph state graph (not raw model/tools)
 * - Uses `graph.streamEvents(input, { version: "v2" })` to intercept
 *   LangGraph internal events (on_chat_model_stream, on_tool_end, etc.)
 * - Translates them into AG-UI protocol events (TEXT_MESSAGE_*, TOOL_CALL_*, STEP_*)
 * - `clone()` per request for isolated state, `run(input)` returns AsyncGenerator
 * - `_dispatch_event()` middleware pattern for subclass interception
 * - `prepare_stream()` for checkpoint state recovery, continue/resume modes
 * - `get_state_and_messages_snapshots()` for state/messages snapshots
 * - Interrupt handling, forwarded_props, error events, RawEvent passthrough
 *
 * @example Using with a prebuilt graph
 * ```ts
 * import { LangGraphAgent } from "ag-ui-langgraph";
 * import { createReactAgent as lgCreateReactAgent } from "@langchain/langgraph/prebuilt";
 *
 * const graph = lgCreateReactAgent({ llm: model, tools });
 * const agent = new LangGraphAgent({ name: "my-agent", graph });
 * const events = agent.clone().run(input);
 * ```
 *
 * @packageDocumentation
 */

import {
  EventType,
  type BaseEvent,
  type RunAgentInput,
  type Tool,
} from "@ag-ui/core";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { v4 as uuid } from "uuid";

import {
  toLangChainMessages,
  langchainMessagesToAgui,
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
  aguiMessagesToLangchain,
} from "./utils/convert.js";
import {
  DEFAULT_SCHEMA_KEYS,
  LangGraphEventTypes,
  CustomEventNames,
} from "./types.js";
import type {
  RunMetadata,
  MessageInProgress,
  MessagesInProgressRecord,
  LangGraphReasoning,
  State,
  SchemaKeys,
  PreparedStream,
  LocalCompiledGraph,
  RunnableConfigLike,
  LangGraphStreamEvent,
  CheckpointSnapshotLike,
  InterruptLike,
  TraceStepKind,
} from "./types.js";
import {
  ROOT_SUBGRAPH_NAME,
  dumpJsonSafe,
  getStreamArgs,
  parseResumeInput,
  sanitizeRawPayloads,
} from "./utils/events.js";
import { getGraphSchemaKeys } from "./utils/schema.js";
import {
  filterOrphanToolMessages,
  mergeLangGraphState,
} from "./utils/state.js";
import {
  asLangGraphStreamEvent,
  getSubgraphInfo,
  isRecord,
} from "./events/guards.js";
import {
  markPredictStateToolIfNeeded,
  translateSingleEvent,
} from "./events/translator.js";
import {
  collectInterrupts,
  detectSubgraphNames,
  getCheckpointBeforeMessage as findCheckpointBeforeMessage,
  getGraphState,
  snapshotMessages,
  snapshotValues,
  streamGraphEvents,
  updateGraphState,
} from "./runtime/graph.js";
import {
  buildRunConfig,
  normalizeRunInput,
  type NormalizedRunAgentInput,
} from "./runtime/input.js";
import type {
  LangGraphPlugin,
  LangGraphPluginContext,
} from "./plugins/trace.js";
import {
  createTraceCustomEvent,
  getCheckpointNamespaceRoot,
  traceSourceFromLangGraphEvent,
  type AgUiTraceSource,
} from "./trace.js";
import {
  buildTraceOwnerFromSource,
  type TraceOwnerMetadata,
} from "./runtime/trace-owner.js";

// ── Configuration types ──

/** Configuration for constructing a LangGraphAgent from a compiled graph. */
export interface LangGraphAgentConfig {
  /** Agent name (used in step events and health checks) */
  name: string;
  /** A compiled LangGraph state graph */
  graph: LocalCompiledGraph;
  /** Optional description */
  description?: string;
  /** Optional runnable config */
  config?: Record<string, unknown>;
  /** Optional protocol plugins */
  plugins?: LangGraphPlugin[];
  /** Known sub-agent names for canonical AG-UI trace spans */
  subAgents?: string[];
}

type ActiveTraceSpan = {
  spanId: string;
  name: string;
  kind: TraceStepKind;
  parentSpanId?: string;
  owner: TraceOwnerMetadata;
};

// ── LangGraphAgent class (fully aligned with Python v0.0.34) ──

/**
 * Core AG-UI agent adapter, fully aligned with Python `ag_ui_langgraph.LangGraphAgent`.
 *
 * Wraps a compiled LangGraph state graph and translates its internal
 * execution events into AG-UI protocol events via `graph.streamEvents()`.
 */
export class LangGraphAgent {
  readonly name: string;
  readonly description?: string;
  readonly graph: LocalCompiledGraph;
  protected readonly _config: Record<string, unknown>;
  protected readonly plugins: LangGraphPlugin[];
  protected readonly traceSubAgents: Set<string>;

  /** Per-request mutable state (reset on clone) */
  protected messagesInProgress: MessagesInProgressRecord = {};
  protected activeRun: RunMetadata | null = null;
  protected traceRunId: string | null = null;
  protected activeTraceSpan: ActiveTraceSpan | null = null;
  protected lastSupervisorSpanId: string | undefined;
  protected lastSupervisorOwnerKey: string | undefined;
  protected traceSpanCounters = new Map<string, number>();
  protected linkedTraceMessages = new Set<string>();
  protected linkedTraceTools = new Set<string>();
  protected traceSpans = new Map<string, ActiveTraceSpan>();
  protected traceOwners = new Map<string, TraceOwnerMetadata>();
  protected traceOwnerSpans = new Map<string, string>();
  protected traceMessageOwners = new Map<string, string>();
  protected traceToolOwners = new Map<string, string>();

  /** Subgraph detection */
  protected subgraphs: Set<string>;

  /** Current subgraph context for boundary detection */
  protected currentSubgraph: string = ROOT_SUBGRAPH_NAME;

  /** Protocol-internal state keys that are always included in schema */
  protected constantSchemaKeys: string[] = ["messages", "tools"];

  constructor(config: LangGraphAgentConfig) {
    this.name = config.name;
    this.description = config.description;
    this.graph = config.graph;
    this._config = config.config ?? {};
    this.plugins = [...(config.plugins ?? [])];
    this.traceSubAgents = new Set(config.subAgents ?? []);

    this.subgraphs = detectSubgraphNames(this.graph);
  }

  /** Create a fresh copy with clean per-request state (aligned with Python `clone()`). */
  clone(): LangGraphAgent {
    try {
      return new (this.constructor as new (
        c: LangGraphAgentConfig,
      ) => LangGraphAgent)({
        name: this.name,
        graph: this.graph,
        description: this.description,
        config: { ...this._config },
        plugins: this.plugins.map((plugin) => plugin.clone?.() ?? plugin),
        subAgents: [...this.traceSubAgents],
      });
    } catch (exc) {
      throw new TypeError(
        `${this.constructor.name} must override clone() or ensure its ` +
          `constructor accepts (LangGraphAgentConfig): ${exc}`,
      );
    }
  }

  /** Run the agent, yielding AG-UI events (aligned with Python `run()`). */
  async *run(input: RunAgentInput): AsyncGenerator<BaseEvent> {
    yield* this._handleStreamEvents(normalizeRunInput(input));
  }

  // ── Event dispatch middleware (aligned with Python _dispatch_event) ──

  /**
   * Central event dispatch point. All events pass through here before yielding.
   * Subclasses can override to intercept, filter, transform, or log events.
   *
   * @returns The event to yield, or null to suppress it.
   */
  protected _dispatchEvent(event: BaseEvent): BaseEvent | null {
    let nextEvent: BaseEvent | null = event;
    const context = this.getPluginContext();

    for (const plugin of this.plugins) {
      if (!nextEvent) break;
      const transformed: BaseEvent | null | void = plugin.beforeDispatchEvent?.(
        nextEvent,
        context,
      );
      if (transformed === null) {
        nextEvent = null;
        break;
      }
      if (transformed) {
        nextEvent = transformed;
      }
    }

    return nextEvent ? sanitizeRawPayloads(nextEvent) : null;
  }

  protected getPluginContext(): LangGraphPluginContext {
    return {
      agentName: this.name,
      activeRun: this.activeRun,
      currentSubgraph: this.currentSubgraph,
      subgraphs: this.subgraphs,
    };
  }

  protected getTraceNamespaceRoot(
    sourceEvent?: LangGraphStreamEvent | null,
  ): string | undefined {
    const checkpointNamespace =
      typeof sourceEvent?.metadata?.langgraph_checkpoint_ns === "string"
        ? sourceEvent.metadata.langgraph_checkpoint_ns
        : undefined;
    const namespaceRoot = getCheckpointNamespaceRoot(checkpointNamespace);

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

  protected resolveTraceStepName(
    stepName: string,
    sourceEvent?: LangGraphStreamEvent | null,
  ): string {
    return (
      this.getTraceNamespaceRoot(sourceEvent) ||
      (this.currentSubgraph !== ROOT_SUBGRAPH_NAME
        ? this.currentSubgraph
        : undefined) ||
      stepName
    );
  }

  protected getActiveTraceStepName(): string | undefined {
    return this.activeTraceSpan?.name;
  }

  protected getActiveTraceOwner(): TraceOwnerMetadata | undefined {
    return this.activeTraceSpan?.owner;
  }

  protected classifyTraceStepKind(stepName: string): TraceStepKind {
    if (stepName === this.name || stepName === "supervisor") {
      return "supervisor";
    }

    if (this.traceSubAgents.has(stepName) || this.subgraphs.has(stepName)) {
      return "subagent";
    }

    return "node";
  }

  protected nextTraceSpanId(stepName: string): string {
    const runId = this.traceRunId ?? this.activeRun?.id ?? "run";
    const key = `${runId}:${stepName}`;
    const next = (this.traceSpanCounters.get(key) ?? 0) + 1;
    this.traceSpanCounters.set(key, next);
    return `${runId}:${stepName}:${next}`;
  }

  protected *emitTraceEvent(
    event: Parameters<typeof createTraceCustomEvent>[0],
  ): Generator<BaseEvent> {
    const ev = this._dispatchEvent(createTraceCustomEvent(event));
    if (ev) yield ev;
  }

  protected buildTraceSource(
    nodeName?: string | null,
    event?: LangGraphStreamEvent | null,
  ): AgUiTraceSource {
    return traceSourceFromLangGraphEvent({
      runId: this.activeRun?.id,
      nodeName: nodeName ?? undefined,
      event: event ?? null,
    });
  }

  protected *startTraceSpan(
    stepName: string,
    sourceEvent?: LangGraphStreamEvent | null,
  ): Generator<BaseEvent> {
    const traceStepName = this.resolveTraceStepName(stepName, sourceEvent);
    const kind = this.classifyTraceStepKind(traceStepName);
    const spanId = this.nextTraceSpanId(traceStepName);
    const parentSpanId =
      kind === "subagent" ? this.lastSupervisorSpanId : undefined;
    const inheritedParentOwnerKey = parentSpanId
      ? this.traceSpans.get(parentSpanId)?.owner.key
      : undefined;
    const owner = buildTraceOwnerFromSource({
      runId: this.traceRunId ?? this.activeRun?.id,
      stepName: traceStepName,
      kind,
      event: sourceEvent,
      owner: inheritedParentOwnerKey
        ? { parentKey: inheritedParentOwnerKey }
        : undefined,
    });

    this.activeTraceSpan = {
      spanId,
      name: traceStepName,
      kind,
      ...(parentSpanId ? { parentSpanId } : {}),
      owner,
    };
    this.traceSpans.set(spanId, this.activeTraceSpan);
    this.traceOwners.set(owner.key, owner);
    this.traceOwnerSpans.set(owner.key, spanId);

    if (kind === "supervisor") {
      this.lastSupervisorSpanId = spanId;
      this.lastSupervisorOwnerKey = owner.key;
    }

    yield* this.emitTraceEvent({
      type: "span.start",
      spanId,
      name: traceStepName,
      kind,
      ...(parentSpanId ? { parentSpanId } : {}),
      owner: {
        key: owner.key,
        type: owner.type,
        instanceId: owner.instanceId,
        ...(owner.parentKey ? { parentKey: owner.parentKey } : {}),
      },
      source: this.buildTraceSource(traceStepName, sourceEvent),
    });
  }

  protected *finishTraceSpan(
    stepName: string,
    sourceEvent?: LangGraphStreamEvent | null,
  ): Generator<BaseEvent> {
    const span = this.activeTraceSpan;
    if (!span) return;
    const traceStepName =
      stepName === span.name
        ? stepName
        : this.resolveTraceStepName(stepName, sourceEvent);
    if (span.name !== traceStepName) return;

    yield* this.emitTraceEvent({
      type: "span.end",
      spanId: span.spanId,
      owner: {
        key: span.owner.key,
        type: span.owner.type,
        instanceId: span.owner.instanceId,
        ...(span.owner.parentKey ? { parentKey: span.owner.parentKey } : {}),
      },
      source: this.buildTraceSource(traceStepName, sourceEvent),
    });

    this.activeTraceSpan = null;
  }

  protected *emitTraceLinksForEvent(
    event: BaseEvent,
    sourceEvent?: LangGraphStreamEvent | null,
  ): Generator<BaseEvent> {
    const activeSpan = this.activeTraceSpan;
    const linkedMessages = this.linkedTraceMessages;
    const linkedTools = this.linkedTraceTools;
    const traceEvent = event as BaseEvent &
      Partial<{
        messageId: string;
        parentMessageId: string;
        role: string;
        toolCallId: string;
        toolCallName: string;
        owner: {
          key: string;
        };
      }>;

    const resolveSpan = (opts: {
      spanId?: string;
      owner?: {
        key: string;
      };
    }): ActiveTraceSpan | null => {
      if (opts.owner?.key) {
        const ownerSpanId = this.traceOwnerSpans.get(opts.owner.key);
        if (ownerSpanId) {
          return this.traceSpans.get(ownerSpanId) ?? activeSpan ?? null;
        }
      }
      if (opts.spanId)
        return this.traceSpans.get(opts.spanId) ?? activeSpan ?? null;
      return activeSpan ?? null;
    };

    const linkMessage = function* (
      self: LangGraphAgent,
      messageId: string | undefined,
      role?: string,
      opts: {
        spanId?: string;
        owner?: {
          key: string;
        };
      } = {},
    ): Generator<BaseEvent> {
      const span = resolveSpan(opts);
      if (!messageId || linkedMessages.has(messageId) || !span) return;
      linkedMessages.add(messageId);
      self.traceMessageOwners.set(messageId, span.owner.key);
      yield* self.emitTraceEvent({
        type: "message.link",
        messageId,
        spanId: span.spanId,
        ...(role ? { role } : {}),
        owner: {
          key: span.owner.key,
          type: span.owner.type,
          instanceId: span.owner.instanceId,
          ...(span.owner.parentKey ? { parentKey: span.owner.parentKey } : {}),
        },
        source: self.buildTraceSource(span.name, sourceEvent),
      });
    };

    const linkTool = function* (
      self: LangGraphAgent,
      toolCallId: string | undefined,
      opts: {
        toolCallName?: string;
        parentMessageId?: string;
        spanId?: string;
        owner?: {
          key: string;
        };
      } = {},
    ): Generator<BaseEvent> {
      if (!toolCallId || linkedTools.has(toolCallId)) return;

      const ownedOwnerKey =
        opts.owner?.key ??
        (opts.parentMessageId
          ? self.traceMessageOwners.get(opts.parentMessageId)
          : undefined) ??
        self.traceToolOwners.get(toolCallId);
      const span = resolveSpan({
        spanId: opts.spanId,
        owner: ownedOwnerKey ? { key: ownedOwnerKey } : undefined,
      });
      if (!span) return;

      linkedTools.add(toolCallId);
      self.traceToolOwners.set(toolCallId, span.owner.key);
      yield* self.emitTraceEvent({
        type: "tool.link",
        toolCallId,
        spanId: span.spanId,
        ...(opts.toolCallName ? { toolCallName: opts.toolCallName } : {}),
        ...(opts.parentMessageId
          ? { parentMessageId: opts.parentMessageId }
          : {}),
        owner: {
          key: span.owner.key,
          type: span.owner.type,
          instanceId: span.owner.instanceId,
          ...(span.owner.parentKey ? { parentKey: span.owner.parentKey } : {}),
        },
        source: self.buildTraceSource(span.name, sourceEvent),
      });
    };

    if (
      event.type === EventType.TEXT_MESSAGE_START ||
      event.type === EventType.REASONING_START ||
      event.type === EventType.REASONING_MESSAGE_START
    ) {
      yield* linkMessage(
        this,
        traceEvent.messageId,
        traceEvent.role ?? "assistant",
        {
          owner:
            traceEvent.owner ??
            (() => {
              const ownerKey = this.traceMessageOwners.get(
                traceEvent.messageId ?? "",
              );
              return ownerKey ? { key: ownerKey } : undefined;
            })(),
        },
      );
    }

    if (event.type === EventType.TOOL_CALL_START) {
      const ownerKey =
        traceEvent.owner?.key ??
        (traceEvent.parentMessageId
          ? this.traceMessageOwners.get(traceEvent.parentMessageId)
          : undefined);
      yield* linkMessage(this, traceEvent.parentMessageId, "assistant", {
        owner: ownerKey ? { key: ownerKey } : undefined,
      });
      yield* linkTool(this, traceEvent.toolCallId, {
        toolCallName: traceEvent.toolCallName,
        parentMessageId: traceEvent.parentMessageId,
        owner: ownerKey ? { key: ownerKey } : undefined,
      });
    }

    if (event.type === EventType.TOOL_CALL_RESULT) {
      const ownerKey =
        traceEvent.owner?.key ??
        (traceEvent.toolCallId
          ? this.traceToolOwners.get(traceEvent.toolCallId)
          : undefined);
      yield* linkMessage(this, traceEvent.messageId, "tool", {
        owner: ownerKey ? { key: ownerKey } : undefined,
      });
      yield* linkTool(this, traceEvent.toolCallId, {
        owner: ownerKey ? { key: ownerKey } : undefined,
      });
    }
  }

  protected getOwnerMetadataForEvent(
    event: BaseEvent &
      Partial<{
        messageId: string;
        parentMessageId: string;
        toolCallId: string;
        owner: {
          key: string;
        };
      }>,
  ): TraceOwnerMetadata | null {
    const directOwnerKey = event.owner?.key;
    if (directOwnerKey) {
      return this.traceOwners.get(directOwnerKey) ?? null;
    }

    if (event.toolCallId) {
      const ownerKey = this.traceToolOwners.get(event.toolCallId);
      if (ownerKey) return this.traceOwners.get(ownerKey) ?? null;
    }

    if (event.parentMessageId) {
      const ownerKey = this.traceMessageOwners.get(event.parentMessageId);
      if (ownerKey) return this.traceOwners.get(ownerKey) ?? null;
    }

    if (event.messageId) {
      const ownerKey = this.traceMessageOwners.get(event.messageId);
      if (ownerKey) return this.traceOwners.get(ownerKey) ?? null;
    }

    return this.getActiveTraceOwner() ?? null;
  }

  protected attachTraceOwnerToEvent(event: BaseEvent): BaseEvent {
    const mutable = event as BaseEvent &
      Partial<{
        messageId: string;
        parentMessageId: string;
        toolCallId: string;
        owner: {
          key: string;
          type: string;
          instanceId: string;
          parentKey?: string;
        };
        emitterId: string;
      }>;
    const owner = this.getOwnerMetadataForEvent(mutable);
    if (!owner) return event;

    mutable.owner ??= {
      key: owner.key,
      type: owner.type,
      instanceId: owner.instanceId,
      ...(owner.parentKey ? { parentKey: owner.parentKey } : {}),
    };
    mutable.emitterId ??= this.activeTraceSpan?.spanId;
    return mutable;
  }

  protected *handleTraceOwnerBoundary(
    currentNodeName: string,
    sourceEvent: LangGraphStreamEvent,
  ): Generator<BaseEvent> {
    const activeSpan = this.activeTraceSpan;
    if (!activeSpan) return;

    const nextStepName = this.resolveTraceStepName(
      currentNodeName,
      sourceEvent,
    );
    if (activeSpan.name !== nextStepName) return;

    const nextOwner = buildTraceOwnerFromSource({
      runId: this.traceRunId ?? this.activeRun?.id,
      stepName: nextStepName,
      kind: this.classifyTraceStepKind(nextStepName),
      event: sourceEvent,
      owner: activeSpan.owner.parentKey
        ? { parentKey: activeSpan.owner.parentKey }
        : undefined,
    });

    if (nextOwner.key === activeSpan.owner.key) return;

    yield* this.finishTraceSpan(activeSpan.name, sourceEvent);
    yield* this.startTraceSpan(currentNodeName, sourceEvent);
  }

  // ── Message-in-progress tracking ──

  protected getMessageInProgress(runId: string): MessageInProgress | null {
    return this.messagesInProgress[runId] ?? null;
  }

  protected setMessageInProgress(
    runId: string,
    value: MessageInProgress | null,
  ): void {
    if (value === null) {
      this.messagesInProgress[runId] = null;
    } else {
      const current = this.messagesInProgress[runId] ?? {};
      this.messagesInProgress[runId] = {
        ...current,
        ...value,
      } as MessageInProgress;
    }
  }

  // ── Schema introspection (aligned with Python get_schema_keys) ──

  protected getSchemaKeys(config: RunnableConfigLike): SchemaKeys {
    try {
      return getGraphSchemaKeys({
        graph: this.graph,
        config,
        constantSchemaKeys: this.constantSchemaKeys,
      });
    } catch {
      return {
        input: this.constantSchemaKeys,
        output: this.constantSchemaKeys,
        config: [],
        context: [],
      };
    }
  }

  /** Filter state to only include schema output keys (aligned with Python get_state_snapshot). */
  protected getStateSnapshot(state: State): State {
    if (!this.activeRun) {
      throw new Error("getStateSnapshot called outside an active run");
    }
    const schemaKeys = this.activeRun.schema_keys;
    const outputKeys = schemaKeys?.output;
    if (outputKeys) {
      return filterObjectBySchemaKeys(state, [
        ...DEFAULT_SCHEMA_KEYS,
        ...outputKeys,
      ]);
    }
    return state;
  }

  // ── Step management (aligned with Python handle_node_change / start_step / end_step) ──

  protected *handleNodeChange(
    nodeName: string | null,
    sourceEvent?: LangGraphStreamEvent | null,
  ): Generator<BaseEvent> {
    if (!this.activeRun) {
      throw new Error("handleNodeChange called outside an active run");
    }

    if (nodeName === "__end__") nodeName = null;

    if (nodeName !== this.activeRun.node_name) {
      const currentTraceStepName = this.activeTraceSpan?.name;
      const nextTraceStepName = nodeName
        ? this.resolveTraceStepName(nodeName, sourceEvent)
        : null;

      // End current step
      if (this.activeRun.node_name) {
        const ev = this._dispatchEvent({
          type: EventType.STEP_FINISHED,
          stepName: this.activeRun.node_name,
        } as BaseEvent);
        if (ev) yield ev;
        if (
          currentTraceStepName &&
          currentTraceStepName !== nextTraceStepName
        ) {
          yield* this.finishTraceSpan(this.activeRun.node_name, sourceEvent);
        }
      }

      // Start new step
      if (nodeName) {
        const ev = this._dispatchEvent({
          type: EventType.STEP_STARTED,
          stepName: nodeName,
        } as BaseEvent);
        if (ev) yield ev;
        if (nextTraceStepName && nextTraceStepName !== currentTraceStepName) {
          yield* this.startTraceSpan(nodeName, sourceEvent);
        }
      }

      this.activeRun.node_name = nodeName;
    }
  }

  // ── Reasoning event handling (aligned with Python handle_reasoning_event) ──

  protected *handleReasoningEvent(
    reasoningData: LangGraphReasoning | null,
    encryptedData: string | null,
    parentMessageId?: string | null,
  ): Generator<BaseEvent> {
    if (!this.activeRun) return;

    const reasoningProcess = this.activeRun.reasoning_process;

    // Handle encrypted reasoning data
    if (encryptedData && reasoningProcess) {
      const ev = this._dispatchEvent({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: reasoningProcess.message_id,
        encryptedValue: encryptedData,
      } as BaseEvent);
      if (ev) yield ev;
      return;
    }

    if (reasoningData) {
      if (!reasoningData.type || reasoningData.text === undefined) return;

      const reasoningStepIndex = reasoningData.index ?? 0;

      // Check for reasoning index change (new reasoning block)
      if (
        reasoningProcess &&
        reasoningProcess.index !== undefined &&
        reasoningProcess.index !== reasoningStepIndex
      ) {
        const msgId = reasoningProcess.message_id ?? uuid();
        if (reasoningProcess.type) {
          const ev = this._dispatchEvent({
            type: EventType.REASONING_MESSAGE_END,
            messageId: msgId,
          } as BaseEvent);
          if (ev) yield ev;
        }
        const ev = this._dispatchEvent({
          type: EventType.REASONING_END,
          messageId: msgId,
        } as BaseEvent);
        if (ev) yield ev;
        this.activeRun.reasoning_process = null;
      }

      // Start reasoning if not started
      if (!this.activeRun.reasoning_process) {
        const messageId = parentMessageId || uuid();
        const ev = this._dispatchEvent({
          type: EventType.REASONING_START,
          messageId,
        } as BaseEvent);
        if (ev) yield ev;

        this.activeRun.reasoning_process = {
          index: reasoningStepIndex,
          message_id: messageId,
        };
      }

      // Start message if type changed
      if (this.activeRun.reasoning_process!.type !== reasoningData.type) {
        const ev = this._dispatchEvent({
          type: EventType.REASONING_MESSAGE_START,
          messageId: this.activeRun.reasoning_process!.message_id,
          role: "reasoning",
        } as BaseEvent);
        if (ev) yield ev;
        this.activeRun.reasoning_process!.type = reasoningData.type;
      }

      // Accumulate signature
      if (reasoningData.signature) {
        this.activeRun.reasoning_process!.signature = reasoningData.signature;
      }

      // Emit content
      if (this.activeRun.reasoning_process!.type) {
        const ev = this._dispatchEvent({
          type: EventType.REASONING_MESSAGE_CONTENT,
          messageId: this.activeRun.reasoning_process!.message_id,
          delta: reasoningData.text,
        } as BaseEvent);
        if (ev) yield ev;
      }
    } else if (reasoningProcess) {
      // Reasoning ended (no more reasoning data but process was active)
      const msgId = reasoningProcess.message_id ?? uuid();

      // Emit signature as encrypted value if accumulated
      if (reasoningProcess.signature) {
        const ev = this._dispatchEvent({
          type: EventType.REASONING_ENCRYPTED_VALUE,
          subtype: "message",
          entityId: msgId,
          encryptedValue: reasoningProcess.signature,
        } as BaseEvent);
        if (ev) yield ev;
      }

      const endMsgEv = this._dispatchEvent({
        type: EventType.REASONING_MESSAGE_END,
        messageId: msgId,
      } as BaseEvent);
      if (endMsgEv) yield endMsgEv;

      const endEv = this._dispatchEvent({
        type: EventType.REASONING_END,
        messageId: msgId,
      } as BaseEvent);
      if (endEv) yield endEv;

      this.activeRun.reasoning_process = null;
    }
  }

  // ── State & messages snapshots (aligned with Python get_state_and_messages_snapshots) ──

  protected async *getStateAndMessagesSnapshots(
    config: RunnableConfigLike,
  ): AsyncGenerator<BaseEvent> {
    if (!this.activeRun) {
      throw new Error(
        "getStateAndMessagesSnapshots called outside an active run",
      );
    }

    try {
      const stateObj = await getGraphState(this.graph, config);
      if (!stateObj) return;
      const stateValues = snapshotValues(stateObj);

      // STATE_SNAPSHOT
      const snapEv = this._dispatchEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.getStateSnapshot(stateValues),
      } as BaseEvent);
      if (snapEv) yield snapEv;

      // MESSAGES_SNAPSHOT
      const rawMessages = snapshotMessages(stateObj);
      const filteredMessages = this._filterOrphanToolMessages(rawMessages);
      const aguiMessages = langchainMessagesToAgui(filteredMessages);
      const msgEv = this._dispatchEvent({
        type: EventType.MESSAGES_SNAPSHOT,
        messages: aguiMessages,
      } as BaseEvent);
      if (msgEv) yield msgEv;
    } catch {
      // Snapshot emission is best-effort — some graphs may not support getState
    }
  }

  // ── Orphan tool message filter (aligned with Python _filter_orphan_tool_messages) ──

  protected _filterOrphanToolMessages(messages: unknown[]): BaseMessage[] {
    return filterOrphanToolMessages(messages);
  }

  // ── Interrupt collection (aligned with Python _collect_interrupts) ──

  protected static _collectInterrupts(
    tasks: Iterable<unknown> | unknown[] | null | undefined,
  ): InterruptLike[] {
    return collectInterrupts(tasks);
  }

  // ── Stream kwargs builder (aligned with Python get_stream_kwargs) ──

  protected getStreamKwargs(opts: {
    input: unknown;
    config?: RunnableConfigLike;
    subgraphs?: boolean;
    version?: "v1" | "v2";
    context?: Record<string, unknown>;
  }): { input: unknown; options: RunnableConfigLike } {
    return getStreamArgs(opts);
  }

  // ── Prepare stream (aligned with Python prepare_stream) ──

  protected async prepareStream(
    input: NormalizedRunAgentInput,
    agentState: CheckpointSnapshotLike,
    config: RunnableConfigLike,
  ): Promise<PreparedStream> {
    if (!this.activeRun) {
      throw new Error("prepareStream called outside an active run");
    }

    const stateInput: State = isRecord(input.state) ? { ...input.state } : {};
    const messages = input.messages ?? [];
    const forwardedProps = input.forwarded_props ?? {};
    const threadId = input.threadId;

    // Get checkpoint messages
    const checkpointMessages = snapshotMessages(agentState);
    stateInput.messages = checkpointMessages;

    const langchainMessages = aguiMessagesToLangchain(messages);

    // Merge state
    const state = this.langgraphDefaultMergeState(
      stateInput,
      langchainMessages,
      input,
    );
    config.configurable = {
      ...(config.configurable ?? {}),
      thread_id: threadId,
    };

    // Detect interrupts
    const interrupts = LangGraphAgent._collectInterrupts(
      agentState?.tasks ?? null,
    );
    const hasActiveInterrupts = interrupts.length > 0;
    const resumeInput = parseResumeInput(forwardedProps.command?.resume);

    // Schema introspection
    this.activeRun.schema_keys = this.getSchemaKeys(config);

    // Check for time-travel / regeneration
    const nonSystemMessages = langchainMessages.filter(
      (m) => !(m instanceof SystemMessage || m._getType?.() === "system"),
    );

    if (checkpointMessages.length > nonSystemMessages.length) {
      const incomingNonToolIds = new Set(
        langchainMessages
          .filter(
            (m) =>
              m.id && !(m instanceof ToolMessage || m._getType?.() === "tool"),
          )
          .map((m) => m.id),
      );
      const checkpointIds = new Set(
        checkpointMessages
          .filter((message) => isRecord(message) && message.id)
          .map((message) => (message as { id: unknown }).id),
      );

      const isContinuation =
        incomingNonToolIds.size > 0 &&
        [...incomingNonToolIds].every((id) => checkpointIds.has(id));

      if (!isContinuation) {
        // Look for last HumanMessage for potential regeneration
        let lastUserMessage: BaseMessage | null = null;
        for (let i = langchainMessages.length - 1; i >= 0; i--) {
          if (
            langchainMessages[i] instanceof HumanMessage ||
            langchainMessages[i]._getType?.() === "human"
          ) {
            lastUserMessage = langchainMessages[i];
            break;
          }
        }

        if (lastUserMessage?.id && checkpointIds.has(lastUserMessage.id)) {
          return this.prepareRegenerateStream(input, lastUserMessage, config);
        }
      }
    }

    // Handle active interrupts without resume
    const eventsToDispatch: BaseEvent[] = [];
    if (hasActiveInterrupts && !resumeInput) {
      eventsToDispatch.push({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);

      for (const interrupt of interrupts) {
        eventsToDispatch.push({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value: dumpJsonSafe(interrupt.value),
        } as BaseEvent);
      }

      eventsToDispatch.push({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);

      return {
        stream: null,
        state: null,
        config: null,
        events_to_dispatch: eventsToDispatch,
      };
    }

    // Continue mode: update state at checkpoint
    if (this.activeRun.mode === "continue") {
      try {
        await updateGraphState(
          this.graph,
          config,
          state,
          this.activeRun.node_name ?? undefined,
        );
      } catch {
        // State update is best-effort
      }
    }

    // Build stream input
    let streamInput: unknown;
    if (resumeInput) {
      streamInput = new Command({ resume: resumeInput });
    } else {
      const payloadInput = getStreamPayloadInput({
        mode: this.activeRun.mode ?? "start",
        state,
        schemaKeys: this.activeRun.schema_keys ?? undefined,
      });
      streamInput = payloadInput
        ? { ...forwardedProps, ...payloadInput }
        : null;
    }

    const subgraphsEnabled = forwardedProps.stream_subgraphs !== false;

    const kwargs = this.getStreamKwargs({
      input: streamInput,
      config,
      subgraphs: subgraphsEnabled,
      version: "v2",
    });

    const stream = streamGraphEvents(this.graph, kwargs.input, kwargs.options);

    return { stream, state, config };
  }

  // ── Prepare regenerate stream (aligned with Python prepare_regenerate_stream) ──

  protected async prepareRegenerateStream(
    input: NormalizedRunAgentInput,
    messageCheckpoint: BaseMessage,
    config: RunnableConfigLike,
  ): Promise<PreparedStream> {
    const messageId = messageCheckpoint.id;
    const threadId = input.threadId;

    if (!messageId) {
      throw new Error(
        "prepareRegenerateStream requires a messageCheckpoint with an id",
      );
    }
    if (!threadId) {
      throw new Error("prepareRegenerateStream requires input.threadId");
    }

    try {
      const timeTravelCheckpoint = await this.getCheckpointBeforeMessage(
        messageId,
        threadId,
        config,
      );

      const nextNodes = timeTravelCheckpoint.next ?? [];
      const forwardedProps = input.forwarded_props ?? {};

      const fork = await updateGraphState(
        this.graph,
        timeTravelCheckpoint.config ?? config,
        snapshotValues(timeTravelCheckpoint),
        nextNodes.length > 0 ? nextNodes[0] : "__start__",
      );

      if (fork !== null) {
        const checkpointValues = snapshotValues(timeTravelCheckpoint);
        const streamInput = this.langgraphDefaultMergeState(
          checkpointValues,
          [messageCheckpoint],
          input,
        );

        const kwargs = this.getStreamKwargs({
          input: streamInput,
          config: {
            ...(Object.keys(config).length > 0 ? config : {}),
            ...(isRecord(fork) ? fork : {}),
          },
          subgraphs: forwardedProps.stream_subgraphs !== false,
          version: "v2",
        });
        const stream = streamGraphEvents(
          this.graph,
          kwargs.input,
          kwargs.options,
        );

        return { stream, state: checkpointValues, config };
      }
    } catch {
      // Time-travel is best-effort; fall through to normal stream
    }

    // Fallback: normal stream
    const messages = toLangChainMessages(input.messages ?? []);
    const agentState = this.langgraphDefaultMergeState({}, messages, input);
    const forwardedProps = input.forwarded_props ?? {};
    const kwargs = this.getStreamKwargs({
      input: agentState,
      config: Object.keys(config).length > 0 ? config : undefined,
      subgraphs: forwardedProps.stream_subgraphs !== false,
      version: "v2",
    });
    const stream = streamGraphEvents(this.graph, kwargs.input, kwargs.options);
    return { stream, state: agentState, config };
  }

  // ── Checkpoint history lookup (aligned with Python get_checkpoint_before_message) ──

  protected async getCheckpointBeforeMessage(
    messageId: string,
    threadId: string,
    config?: RunnableConfigLike,
  ): Promise<CheckpointSnapshotLike> {
    if (!threadId) throw new Error("Missing threadId");

    return findCheckpointBeforeMessage({
      graph: this.graph,
      messageId,
      threadId,
      config,
    });
  }

  // ── Default state merge (aligned with Python langgraph_default_merge_state) ──

  protected langgraphDefaultMergeState(
    state: State,
    messages: BaseMessage[],
    input: RunAgentInput,
  ): State {
    return mergeLangGraphState({ state, messages, input });
  }

  // ── Main event loop (fully aligned with Python _handle_stream_events) ──

  protected async *_handleStreamEvents(
    input: NormalizedRunAgentInput,
  ): AsyncGenerator<BaseEvent> {
    const threadId = input.threadId ?? uuid();
    const runId = input.runId ?? uuid();
    const frontendTools: Tool[] = input.tools ?? [];
    const frontendToolNames = new Set(frontendTools.map((t) => t.name));
    const forwardedProps = input.forwarded_props ?? {};

    this.activeRun = {
      id: runId,
      thread_id: threadId,
      mode: "start",
      node_name: null,
      prev_node_name: null,
      has_function_streaming: false,
      streamed_tool_call_ids: new Set<string>(),
      model_made_tool_call: false,
      state_reliable: true,
      reasoning_process: null,
      manually_emitted_state: null,
      wait_for_frontend_tool: false,
    };
    this.traceRunId = runId;
    this.activeTraceSpan = null;
    this.lastSupervisorSpanId = undefined;
    this.lastSupervisorOwnerKey = undefined;
    this.traceSpanCounters.clear();
    this.linkedTraceMessages.clear();
    this.linkedTraceTools.clear();
    this.traceSpans.clear();
    this.traceOwners.clear();
    this.traceOwnerSpans.clear();
    this.traceMessageOwners.clear();
    this.traceToolOwners.clear();

    for (const plugin of this.plugins) {
      plugin.onRunStart?.(this.getPluginContext());
    }

    try {
      const nodeNameInput = forwardedProps.node_name ?? null;
      const config = buildRunConfig(this._config, threadId);

      let agentState: CheckpointSnapshotLike | null = null;
      let usePrepareStream = false;
      try {
        agentState = await getGraphState(this.graph, config);
        usePrepareStream = agentState !== null;

        const resumeInput = forwardedProps.command?.resume ?? null;
        if (
          resumeInput == null &&
          threadId &&
          this.activeRun.node_name !== "__end__" &&
          (agentState?.next?.length ?? 0) > 0
        ) {
          this.activeRun.mode = "continue";
        }
      } catch {
        // No checkpoint support — proceed with direct stream.
      }

      let streamState: State;
      let stream: AsyncIterable<LangGraphStreamEvent>;
      let streamConfig = config;

      if (usePrepareStream && agentState) {
        const prepared = await this.prepareStream(input, agentState, config);

        if (
          prepared.events_to_dispatch &&
          prepared.events_to_dispatch.length > 0
        ) {
          for (const ev of prepared.events_to_dispatch) {
            const dispatched = this._dispatchEvent(ev);
            if (dispatched) yield dispatched;
          }
          return;
        }

        stream = prepared.stream!;
        streamState = prepared.state ?? {};
        streamConfig = prepared.config ?? config;
      } else {
        const messages = toLangChainMessages(input.messages ?? []);
        streamState = this.langgraphDefaultMergeState({}, messages, input);
        const kwargs = this.getStreamKwargs({
          input: streamState,
          config: Object.keys(config).length > 0 ? config : undefined,
          subgraphs: forwardedProps.stream_subgraphs !== false,
          version: "v2",
        });
        stream = streamGraphEvents(this.graph, kwargs.input, kwargs.options);
      }

      const startEv = this._dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);
      if (startEv) yield startEv;

      for (const ev of this.handleNodeChange(nodeNameInput)) {
        yield ev;
      }

      const resumeInput = forwardedProps.command?.resume ?? null;
      if (resumeInput && this.activeRun.node_name) {
        for (const ev of this.handleNodeChange(this.activeRun.node_name)) {
          yield ev;
        }
      }

      let shouldExit = false;
      let currentGraphState: State = { ...streamState };

      for await (const rawEvent of stream) {
        const event = asLangGraphStreamEvent(rawEvent);
        const eventType = event.event;
        const eventName = event.name ?? "";
        const eventData = isRecord(event.data) ? event.data : {};
        const metadata = event.metadata ?? {};

        const subgraphInfo = getSubgraphInfo({
          eventType,
          metadata,
          subgraphs: this.subgraphs,
          streamSubgraphs: forwardedProps.stream_subgraphs !== false,
        });

        if (
          subgraphInfo.isSubgraphStream &&
          subgraphInfo.currentSubgraph !== this.currentSubgraph
        ) {
          const currentNodeName = this.activeRun.node_name;
          const previousTraceStepName = this.getActiveTraceStepName();
          this.currentSubgraph =
            subgraphInfo.currentSubgraph ?? ROOT_SUBGRAPH_NAME;
          const nextTraceStepName = currentNodeName
            ? this.resolveTraceStepName(currentNodeName, event)
            : null;

          if (
            currentNodeName &&
            previousTraceStepName &&
            previousTraceStepName !== nextTraceStepName
          ) {
            yield* this.finishTraceSpan(previousTraceStepName, event);
            if (nextTraceStepName) {
              yield* this.startTraceSpan(currentNodeName, event);
            }
          }

          for await (const snapEv of this.getStateAndMessagesSnapshots(
            streamConfig,
          )) {
            yield snapEv;
          }
        }

        if (eventType === "error") {
          const errorMessage =
            typeof eventData.message === "string" ? eventData.message : null;
          const ev = this._dispatchEvent({
            type: EventType.RUN_ERROR,
            message: errorMessage ?? "Unknown error",
          } as BaseEvent);
          if (ev) yield ev;
          break;
        }

        const currentNodeName =
          typeof metadata.langgraph_node === "string"
            ? metadata.langgraph_node
            : undefined;
        const eventRunId = event.run_id;
        if (typeof eventRunId === "string" && eventRunId) {
          this.activeRun.id = eventRunId;
        }
        let exitingNode = false;

        if (
          eventType === LangGraphEventTypes.OnChainEnd &&
          isRecord(eventData.output)
        ) {
          const output = eventData.output;
          Object.assign(currentGraphState, output);
          exitingNode = this.activeRun.node_name === currentNodeName;
          if (
            Object.keys(output).some(
              (key) => !["messages", "tools", "ag-ui"].includes(key),
            )
          ) {
            this.activeRun.state_reliable = true;
          }
        }

        shouldExit =
          shouldExit ||
          (eventType === LangGraphEventTypes.OnCustomEvent &&
            eventName === CustomEventNames.Exit);

        if (currentNodeName && currentNodeName !== this.activeRun.node_name) {
          for (const stepEvent of this.handleNodeChange(
            currentNodeName,
            event,
          )) {
            yield stepEvent;
          }
        } else if (currentNodeName) {
          yield* this.handleTraceOwnerBoundary(currentNodeName, event);
        }

        markPredictStateToolIfNeeded(event, this.activeRun);

        const manuallyEmitted = this.activeRun.manually_emitted_state;
        const updatedState =
          manuallyEmitted !== undefined && manuallyEmitted !== null
            ? manuallyEmitted
            : currentGraphState;
        const hasStateDiff = updatedState !== streamState;

        if (
          exitingNode ||
          (hasStateDiff && !this.getMessageInProgress(this.activeRun.id))
        ) {
          streamState = updatedState;
          this.activeRun.prev_node_name = this.activeRun.node_name;
          Object.assign(currentGraphState, updatedState);

          const modelMadeToolCall = this.activeRun.model_made_tool_call;
          const stateReliable = this.activeRun.state_reliable ?? true;
          const suppressed =
            exitingNode && (modelMadeToolCall || !stateReliable);

          if (suppressed) {
            this.activeRun.model_made_tool_call = false;
            if (modelMadeToolCall) {
              this.activeRun.state_reliable = false;
            }
          } else {
            const snapEv = this._dispatchEvent({
              type: EventType.STATE_SNAPSHOT,
              snapshot: this.getStateSnapshot(streamState),
            } as BaseEvent);
            if (snapEv) yield snapEv;
          }
        }

        const rawEv = this._dispatchEvent({
          type: EventType.RAW,
          event,
        } as BaseEvent);
        if (rawEv) yield rawEv;

        for await (const agUiEvent of this._handleSingleEvent(
          event,
          frontendToolNames,
          currentGraphState,
        )) {
          yield agUiEvent;
        }

        if (this.activeRun.wait_for_frontend_tool || shouldExit) {
          break;
        }
      }

      try {
        const finalState = await getGraphState(this.graph, streamConfig);
        if (finalState) {
          const interrupts = LangGraphAgent._collectInterrupts(
            finalState.tasks,
          );
          const stateMetadata = finalState.metadata ?? {};
          const writes = isRecord(stateMetadata.writes)
            ? stateMetadata.writes
            : {};
          let nodeName: string | null =
            interrupts.length > 0
              ? (this.activeRun.node_name ?? null)
              : (Object.keys(writes)[0] ?? null);

          const nextNodes = finalState.next ?? [];
          const isEndNode = nextNodes.length === 0 && interrupts.length === 0;
          nodeName = isEndNode ? "__end__" : nodeName;

          for (const interrupt of interrupts) {
            const ev = this._dispatchEvent({
              type: EventType.CUSTOM,
              name: LangGraphEventTypes.OnInterrupt,
              value: dumpJsonSafe(interrupt.value),
            } as BaseEvent);
            if (ev) yield ev;
          }

          if (this.activeRun.node_name !== nodeName) {
            for (const ev of this.handleNodeChange(nodeName)) {
              yield ev;
            }
          }

          for await (const ev of this.getStateAndMessagesSnapshots(
            streamConfig,
          )) {
            yield ev;
          }
        }
      } catch {
        // Post-stream state check is best-effort.
      }

      for (const stepEvent of this.handleNodeChange(null)) {
        yield stepEvent;
      }

      const finishEv = this._dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);
      if (finishEv) yield finishEv;
    } finally {
      for (const plugin of this.plugins) {
        plugin.onRunFinish?.(this.getPluginContext());
      }
      this.activeTraceSpan = null;
      this.traceRunId = null;
      this.lastSupervisorSpanId = undefined;
      this.lastSupervisorOwnerKey = undefined;
      this.traceSpanCounters.clear();
      this.linkedTraceMessages.clear();
      this.linkedTraceTools.clear();
      this.traceSpans.clear();
      this.traceOwners.clear();
      this.traceOwnerSpans.clear();
      this.traceMessageOwners.clear();
      this.traceToolOwners.clear();
      this.activeRun = null;
    }
  }

  protected async *_handleSingleEvent(
    event: LangGraphStreamEvent,
    frontendToolNames: Set<string>,
    currentState?: State,
  ): AsyncGenerator<BaseEvent> {
    void currentState;
    if (!this.activeRun) {
      throw new Error("_handleSingleEvent called outside an active run");
    }

    for await (const agUiEvent of translateSingleEvent(event, {
      activeRun: this.activeRun,
      frontendToolNames,
      getMessageInProgress: (id) => this.getMessageInProgress(id),
      setMessageInProgress: (id, value) => this.setMessageInProgress(id, value),
      clearMessageInProgress: (id) => {
        this.messagesInProgress[id] = null;
      },
      dispatchEvent: (ev) => this._dispatchEvent(ev),
      handleReasoningEvent: (reasoningData, encryptedData, parentMessageId) =>
        this.handleReasoningEvent(
          reasoningData,
          encryptedData,
          parentMessageId,
        ),
    })) {
      const enrichedEvent = this.attachTraceOwnerToEvent(agUiEvent);
      yield enrichedEvent;
      yield* this.emitTraceLinksForEvent(enrichedEvent, event);
    }
  }
}
