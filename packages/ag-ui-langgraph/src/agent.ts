/**
 * LangGraphAgent — AG-UI protocol adapter for LangGraph compiled graphs.
 *
 * **Aligned with Python `ag_ui_langgraph.LangGraphAgent`:**
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
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import { v4 as uuid } from "uuid";

import {
  toLangChainMessages,
  langchainMessagesToAgui,
  filterObjectBySchemaKeys,
  aguiMessagesToLangchain,
} from "./messages/convert.js";
import {
  DEFAULT_SCHEMA_KEYS,
  LangGraphEventTypes,
  CustomEventNames,
} from "./types.js";
import type {
  RunMetadata,
  MessageInProgress,
  MessagesInProgressRecord,
  State,
  SchemaKeys,
  PreparedStream,
  LocalCompiledGraph,
  RunnableConfigLike,
  LangGraphStreamEvent,
  CheckpointSnapshotLike,
  InterruptLike,
} from "./types.js";
import {
  ROOT_SUBGRAPH_NAME,
  dumpJsonSafe,
  getStreamArgs,
  parseResumeInput,
  sanitizeRawPayloads,
} from "./runtime/stream.js";
import { getGraphSchemaKeys } from "./state/schema.js";
import {
  filterOrphanToolMessages,
  mergeLangGraphState,
} from "./state/merge.js";
import {
  asLangGraphStreamEvent,
  getSubgraphInfo,
  isRecord,
} from "./events/guards.js";
import {
  markPredictStateToolIfNeeded,
  translateSingleEvent,
} from "./translation/translator.js";
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
import { handleReasoningEvent as handleReasoningEventForRun } from "./agent/reasoning.js";
import {
  clearMessageInProgress,
  getMessageInProgress as readMessageInProgress,
  setMessageInProgress as writeMessageInProgress,
} from "./agent/message-state.js";
import { createRunMetadata } from "./agent/run-state.js";
import {
  buildInterruptEvents,
  buildPreparedStreamInput,
  findRegenerationMessage,
  getCheckpointMessages,
} from "./agent/stream-preparation.js";
import {
  createExtensionContext,
  type LangGraphEventExtension,
  type LangGraphEventExtensionContext,
} from "./extensions.js";

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
  /** Optional event extensions for adding business-defined `extra` data */
  eventExtensions?: LangGraphEventExtension[];
}

// ── LangGraphAgent class (aligned with Python ag_ui_langgraph) ──

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
  protected readonly eventExtensions: LangGraphEventExtension[];

  /** Per-request mutable state (reset on clone) */
  protected messagesInProgress: MessagesInProgressRecord = {};
  protected activeRun: RunMetadata | null = null;

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
    this.eventExtensions = [...(config.eventExtensions ?? [])];

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
        eventExtensions: this.eventExtensions.map(
          (extension) => extension.clone?.() ?? extension,
        ),
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
  protected _dispatchEvent(
    event: BaseEvent,
    sourceEvent?: LangGraphStreamEvent | null,
  ): BaseEvent | null {
    let nextEvent: BaseEvent | null = event;
    const context = this.getExtensionContext(sourceEvent);

    for (const extension of this.eventExtensions) {
      if (!nextEvent) break;
      const transformed: BaseEvent | null | void =
        extension.beforeDispatchEvent?.(nextEvent, context);
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

  protected getExtensionContext(
    sourceEvent?: LangGraphStreamEvent | null,
  ): LangGraphEventExtensionContext {
    return createExtensionContext({
      agentName: this.name,
      activeRun: this.activeRun,
      currentSubgraph: this.currentSubgraph,
      subgraphs: this.subgraphs,
      sourceEvent,
    });
  }

  // ── Message-in-progress tracking ──

  protected getMessageInProgress(runId: string): MessageInProgress | null {
    return readMessageInProgress(this.messagesInProgress, runId);
  }

  protected setMessageInProgress(
    runId: string,
    value: MessageInProgress | null,
  ): void {
    writeMessageInProgress(this.messagesInProgress, runId, value);
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

    if (nodeName === "__start__" || nodeName === "__end__") nodeName = null;

    if (nodeName !== this.activeRun.node_name) {
      // End current step
      if (this.activeRun.node_name) {
        const ev = this._dispatchEvent(
          {
            type: EventType.STEP_FINISHED,
            stepName: this.activeRun.node_name,
          } as BaseEvent,
          sourceEvent,
        );
        if (ev) yield ev;
      }

      // Start new step
      if (nodeName) {
        const ev = this._dispatchEvent(
          {
            type: EventType.STEP_STARTED,
            stepName: nodeName,
          } as BaseEvent,
          sourceEvent,
        );
        if (ev) yield ev;
      }

      this.activeRun.node_name = nodeName;
    }
  }

  // ── Reasoning event handling (aligned with Python handle_reasoning_event) ──

  protected *handleReasoningEvent(
    reasoningData: import("./types.js").LangGraphReasoning | null,
    encryptedData: string | null,
    parentMessageId?: string | null,
    sourceEvent?: LangGraphStreamEvent | null,
  ): Generator<BaseEvent> {
    yield* handleReasoningEventForRun(
      {
        activeRun: this.activeRun,
        dispatchEvent: (event) => this._dispatchEvent(event, sourceEvent),
      },
      reasoningData,
      encryptedData,
      parentMessageId,
    );
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
    const checkpointMessages = getCheckpointMessages(agentState);
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

    const regenerationMessage = findRegenerationMessage({
      checkpointMessages,
      langchainMessages,
    });
    if (regenerationMessage) {
      return this.prepareRegenerateStream(input, regenerationMessage, config);
    }

    // Handle active interrupts without resume
    if (hasActiveInterrupts && !resumeInput) {
      return {
        stream: null,
        state: null,
        config: null,
        events_to_dispatch: buildInterruptEvents({
          activeRun: this.activeRun,
          threadId,
          interrupts,
        }),
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
    const streamInput = buildPreparedStreamInput({
      activeRun: this.activeRun,
      forwardedProps,
      resumeInput,
      state,
      schemaKeys: this.activeRun.schema_keys ?? undefined,
    });

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

    this.activeRun = createRunMetadata({ runId, threadId });

    for (const extension of this.eventExtensions) {
      extension.onRunStart?.(this.getExtensionContext());
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
          this.currentSubgraph =
            subgraphInfo.currentSubgraph ?? ROOT_SUBGRAPH_NAME;

          for await (const snapEv of this.getStateAndMessagesSnapshots(
            streamConfig,
          )) {
            yield snapEv;
          }
        }

        if (eventType === "error") {
          const errorMessage =
            typeof eventData.message === "string" ? eventData.message : null;
          const ev = this._dispatchEvent(
            {
              type: EventType.RUN_ERROR,
              message: errorMessage ?? "Unknown error",
            } as BaseEvent,
            event,
          );
          if (ev) yield ev;
          break;
        }

        const currentNodeName =
          typeof metadata.langgraph_node === "string"
            ? metadata.langgraph_node
            : undefined;
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
            const snapEv = this._dispatchEvent(
              {
                type: EventType.STATE_SNAPSHOT,
                snapshot: this.getStateSnapshot(streamState),
              } as BaseEvent,
              event,
            );
            if (snapEv) yield snapEv;
          }
        }

        const rawEv = this._dispatchEvent(
          {
            type: EventType.RAW,
            event,
          } as BaseEvent,
          event,
        );
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
      for (const extension of this.eventExtensions) {
        extension.onRunFinish?.(this.getExtensionContext());
      }
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
        clearMessageInProgress(this.messagesInProgress, id);
      },
      dispatchEvent: (ev) => this._dispatchEvent(ev, event),
      handleReasoningEvent: (reasoningData, encryptedData, parentMessageId) =>
        this.handleReasoningEvent(
          reasoningData,
          encryptedData,
          parentMessageId,
          event,
        ),
    })) {
      yield agUiEvent;
    }
  }
}
