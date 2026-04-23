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
 * import { LangGraphAgent } from "ag-ui-langchain";
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
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { v4 as uuid } from "uuid";

import {
  contentToString,
  frontendToolToModelTool,
  toLangChainMessages,
  langchainMessagesToAgui,
  resolveReasoningContent,
  resolveEncryptedReasoningContent,
  resolveMessageContent,
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
  aguiMessagesToLangchain,
  camelToSnake,
  normalizeToolContent,
  jsonSafeStringify,
  makeJsonSafe,
} from "./convert.js";
import {
  DEFAULT_SCHEMA_KEYS,
  LangGraphEventTypes,
  CustomEventNames,
} from "./types.js";
import type {
  StreamEventMetadata,
  RunMetadata,
  MessageInProgress,
  MessagesInProgressRecord,
  LangGraphReasoning,
  ThinkingProcess,
  State,
  SchemaKeys,
  PreparedStream,
  ForwardedProps,
} from "./types.js";

// ── Constants ──

const ROOT_SUBGRAPH_NAME = "__root__";

// ── Configuration types ──

/** Configuration for constructing a LangGraphAgent from a compiled graph. */
export interface LangGraphAgentConfig {
  /** Agent name (used in step events and health checks) */
  name: string;
  /** A compiled LangGraph state graph */
  graph: CompiledStateGraph<any, any, any>;
  /** Optional description */
  description?: string;
  /** Optional runnable config */
  config?: Record<string, unknown>;
}

/** Configuration for createReactAgent factory (convenience). */
export interface ReactAgentConfig {
  /** Display name for this agent */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools (server-side execution) */
  tools?: any[];
  /** System prompt */
  systemPrompt?: string;
}

/** Sub-agent definition for supervisor factory. */
export interface SubAgentDefinition {
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /** Tools available to the sub-agent */
  tools: any[];
  /** Optional: override model for this sub-agent */
  model?: BaseChatModel;
}

/** Configuration for createSupervisor factory. */
export interface SupervisorConfig {
  /** Display name */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools the supervisor can call directly */
  tools?: any[];
  /** System prompt */
  systemPrompt?: string;
  /** Sub-agent definitions keyed by name */
  subAgents: Record<string, SubAgentDefinition>;
}

// ── Helper: chunk property access (handles both dict and object) ──

function chunkGet(chunk: any, key: string, defaultValue: any = undefined): any {
  if (chunk == null) return defaultValue;
  if (typeof chunk === "object" && key in chunk) return chunk[key];
  return defaultValue;
}

// ── Helper: dump JSON safely ──

function dumpJsonSafe(value: unknown): unknown {
  try {
    return makeJsonSafe(value);
  } catch {
    return String(value);
  }
}

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
  readonly graph: CompiledStateGraph<any, any, any>;
  protected readonly _config: Record<string, unknown>;

  /** Per-request mutable state (reset on clone) */
  protected messagesInProgress: MessagesInProgressRecord = {};
  protected activeRun: RunMetadata | null = null;

  /** Subgraph detection */
  protected subgraphs: Set<string>;

  /** Current subgraph context for boundary detection */
  protected currentSubgraph: string = ROOT_SUBGRAPH_NAME;

  /** Protocol-internal state keys that are always included in schema */
  protected constantSchemaKeys: string[] = ["messages", "tools"];

  /** Regex for orphan tool message detection */
  private static readonly ORPHAN_TOOL_MSG_RE =
    /^Error: No tool call found with id/;

  constructor(config: LangGraphAgentConfig) {
    this.name = config.name;
    this.description = config.description;
    this.graph = config.graph;
    this._config = config.config ?? {};

    // Detect subgraph nodes (nodes whose bound runnable is a CompiledStateGraph)
    this.subgraphs = new Set<string>();
    try {
      const nodes = (this.graph as any).nodes;
      if (nodes && typeof nodes === "object") {
        for (const [nodeName, node] of Object.entries(nodes)) {
          const bound = (node as any)?.bound;
          if (bound?.constructor?.name === "CompiledStateGraph") {
            this.subgraphs.add(nodeName);
          }
        }
      }
    } catch {
      // Subgraph detection is best-effort
    }
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
    // Normalize camelCase keys from the frontend to snake_case before forwarding.
    let forwardedProps: ForwardedProps = {};
    if ((input as any).forwardedProps || (input as any).forwarded_props) {
      const raw =
        (input as any).forwardedProps ?? (input as any).forwarded_props ?? {};
      forwardedProps = Object.fromEntries(
        Object.entries(raw).map(([k, v]) => [camelToSnake(k), v]),
      );
    }

    const normalizedInput = {
      ...input,
      forwarded_props: forwardedProps,
    } as any;
    yield* this._handleStreamEvents(normalizedInput);
  }

  // ── Event dispatch middleware (aligned with Python _dispatch_event) ──

  /**
   * Central event dispatch point. All events pass through here before yielding.
   * Subclasses can override to intercept, filter, transform, or log events.
   *
   * @returns The event to yield, or null to suppress it.
   */
  protected _dispatchEvent(event: BaseEvent): BaseEvent | null {
    return event;
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

  protected getSchemaKeys(config: Record<string, any>): SchemaKeys {
    try {
      const graph = this.graph as any;
      const inputSchema =
        graph.getInputJsonSchema?.(config) ?? graph.inputSchema?.() ?? {};
      const outputSchema =
        graph.getOutputJsonSchema?.(config) ?? graph.outputSchema?.() ?? {};

      const inputKeys = inputSchema?.properties
        ? Object.keys(inputSchema.properties)
        : [];
      const outputKeys = outputSchema?.properties
        ? Object.keys(outputSchema.properties)
        : [];

      return {
        input: [...inputKeys, ...this.constantSchemaKeys],
        output: [...outputKeys, ...this.constantSchemaKeys],
        config: [],
        context: [],
      };
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

  protected *handleNodeChange(nodeName: string | null): Generator<BaseEvent> {
    if (!this.activeRun) {
      throw new Error("handleNodeChange called outside an active run");
    }

    if (nodeName === "__end__") nodeName = null;

    if (nodeName !== this.activeRun.node_name) {
      // End current step
      if (this.activeRun.node_name) {
        const ev = this._dispatchEvent({
          type: EventType.STEP_FINISHED,
          stepName: this.activeRun.node_name,
        } as BaseEvent);
        if (ev) yield ev;
      }

      // Start new step
      if (nodeName) {
        const ev = this._dispatchEvent({
          type: EventType.STEP_STARTED,
          stepName: nodeName,
        } as BaseEvent);
        if (ev) yield ev;
      }

      this.activeRun.node_name = nodeName;
    }
  }

  // ── Reasoning event handling (aligned with Python handle_reasoning_event) ──

  protected *handleReasoningEvent(
    reasoningData: LangGraphReasoning | null,
    encryptedData: string | null,
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
      } as any);
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
        const messageId = uuid();
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
        } as any);
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
    config: Record<string, any>,
  ): AsyncGenerator<BaseEvent> {
    if (!this.activeRun) {
      throw new Error(
        "getStateAndMessagesSnapshots called outside an active run",
      );
    }

    try {
      const graph = this.graph as any;
      if (typeof graph.getState !== "function") return;

      const stateObj = await graph.getState(config);
      const stateValues: State = stateObj?.values ?? {};

      // STATE_SNAPSHOT
      const snapEv = this._dispatchEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: this.getStateSnapshot(stateValues),
      } as BaseEvent);
      if (snapEv) yield snapEv;

      // MESSAGES_SNAPSHOT
      const rawMessages: any[] = (stateValues.messages as any[]) ?? [];
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

  protected _filterOrphanToolMessages(messages: any[]): any[] {
    // Find the index of the last HumanMessage
    let lastHumanIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (
        messages[i] instanceof HumanMessage ||
        messages[i]?._getType?.() === "human"
      ) {
        lastHumanIdx = i;
        break;
      }
    }

    if (lastHumanIdx === -1) return messages;

    const head = messages.slice(0, lastHumanIdx + 1);
    const tail = messages.slice(lastHumanIdx + 1).filter((m) => {
      if (
        (m instanceof ToolMessage || m?._getType?.() === "tool") &&
        typeof m.content === "string" &&
        LangGraphAgent.ORPHAN_TOOL_MSG_RE.test(m.content)
      ) {
        return false;
      }
      return true;
    });

    return [...head, ...tail];
  }

  // ── Interrupt collection (aligned with Python _collect_interrupts) ──

  protected static _collectInterrupts(tasks: any[] | null): any[] {
    if (!tasks || tasks.length === 0) return [];
    const interrupts: any[] = [];
    for (const task of tasks) {
      const taskInterrupts = task?.interrupts ?? [];
      interrupts.push(...taskInterrupts);
    }
    return interrupts;
  }

  // ── Stream kwargs builder (aligned with Python get_stream_kwargs) ──

  protected getStreamKwargs(opts: {
    input: any;
    config?: Record<string, any>;
    subgraphs?: boolean;
    version?: "v1" | "v2";
  }): Record<string, any> {
    const kwargs: Record<string, any> = {
      input: opts.input,
      version: opts.version ?? "v2",
    };

    if (opts.config) {
      kwargs.config = opts.config;
    }

    return kwargs;
  }

  // ── Prepare stream (aligned with Python prepare_stream) ──

  protected async prepareStream(
    input: RunAgentInput & { forwarded_props?: ForwardedProps },
    agentState: any,
    config: Record<string, any>,
  ): Promise<PreparedStream> {
    if (!this.activeRun) {
      throw new Error("prepareStream called outside an active run");
    }

    const stateInput: State = (input as any).state ?? {};
    const messages = input.messages ?? [];
    const forwardedProps: ForwardedProps = (input as any).forwarded_props ?? {};
    const threadId = input.threadId;

    // Get checkpoint messages
    const checkpointMessages: any[] = agentState?.values?.messages ?? [];
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
    const resumeInput = forwardedProps.command?.resume ?? null;

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
        checkpointMessages.filter((m: any) => m.id).map((m: any) => m.id),
      );

      const isContinuation =
        incomingNonToolIds.size > 0 &&
        [...incomingNonToolIds].every((id) => checkpointIds.has(id));

      if (!isContinuation) {
        // Look for last HumanMessage for potential regeneration
        let lastUserMessage: any = null;
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
        const graph = this.graph as any;
        if (typeof graph.updateState === "function") {
          await graph.updateState(config, state, {
            asNode: this.activeRun.node_name,
          });
        }
      } catch {
        // State update is best-effort
      }
    }

    // Build stream input
    let streamInput: any;
    if (resumeInput) {
      // For Command resume — try to use LangGraph Command type
      try {
        const { Command } = require("@langchain/langgraph");
        streamInput = new Command({ resume: resumeInput });
      } catch {
        streamInput = { resume: resumeInput };
      }
    } else {
      const payloadInput = getStreamPayloadInput({
        mode: this.activeRun.mode ?? "start",
        state,
        schemaKeys: this.activeRun.schema_keys ?? undefined,
      });
      streamInput = payloadInput ?? null;
    }

    const subgraphsEnabled = forwardedProps.stream_subgraphs !== false;

    const kwargs = this.getStreamKwargs({
      input: streamInput,
      config,
      subgraphs: subgraphsEnabled,
      version: "v2",
    });

    const stream = this.graph.streamEvents(kwargs.input, {
      version: "v2" as any,
      ...(kwargs.config ? { config: kwargs.config } : {}),
    });

    return { stream, state, config };
  }

  // ── Prepare regenerate stream (aligned with Python prepare_regenerate_stream) ──

  protected async prepareRegenerateStream(
    input: RunAgentInput,
    messageCheckpoint: any,
    config: Record<string, any>,
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
      const graph = this.graph as any;

      if (typeof graph.updateState === "function") {
        const fork = await graph.updateState(
          timeTravelCheckpoint.config,
          timeTravelCheckpoint.values,
          { asNode: nextNodes.length > 0 ? nextNodes[0] : "__start__" },
        );

        const streamInput = this.langgraphDefaultMergeState(
          timeTravelCheckpoint.values,
          [messageCheckpoint],
          input,
        );

        const stream = this.graph.streamEvents(streamInput, {
          version: "v2" as any,
          ...(fork as Record<string, unknown>),
        });

        return { stream, state: timeTravelCheckpoint.values, config };
      }
    } catch {
      // Time-travel is best-effort; fall through to normal stream
    }

    // Fallback: normal stream
    const messages = toLangChainMessages(input.messages);
    const agentState: State = { messages };
    const stream = this.graph.streamEvents(agentState, {
      version: "v2" as any,
    });
    return { stream, state: agentState, config };
  }

  // ── Checkpoint history lookup (aligned with Python get_checkpoint_before_message) ──

  protected async getCheckpointBeforeMessage(
    messageId: string,
    threadId: string,
    config?: Record<string, any>,
  ): Promise<any> {
    if (!threadId) throw new Error("Missing threadId");

    const graph = this.graph as any;
    if (typeof graph.getStateHistory !== "function") {
      throw new Error("Graph does not support getStateHistory");
    }

    const historyConfig: Record<string, any> = config
      ? {
          ...config,
          configurable: {
            ...Object.fromEntries(
              Object.entries(config.configurable ?? {}).filter(
                ([k]) => k !== "checkpoint_id" && k !== "checkpoint_ns",
              ),
            ),
            thread_id: threadId,
          },
        }
      : { configurable: { thread_id: threadId } };

    const historyList: any[] = [];
    for await (const snapshot of graph.getStateHistory(historyConfig)) {
      historyList.push(snapshot);
    }

    historyList.reverse();

    for (let idx = 0; idx < historyList.length; idx++) {
      const snapshot = historyList[idx];
      const messages = snapshot.values?.messages ?? [];
      if (messages.some((m: any) => m.id === messageId)) {
        if (idx === 0) {
          // No snapshot before this — return empty-messages version
          return { ...snapshot, values: { ...snapshot.values, messages: [] } };
        }
        const checkpoint = historyList[idx - 1];
        const snapshotValuesWithoutMessages = { ...snapshot.values };
        delete snapshotValuesWithoutMessages.messages;
        return {
          ...checkpoint,
          values: { ...checkpoint.values, ...snapshotValuesWithoutMessages },
        };
      }
    }

    throw new Error(
      `Message ID "${messageId}" not found in history (thread_id=${threadId}, snapshots=${historyList.length})`,
    );
  }

  // ── Default state merge (aligned with Python langgraph_default_merge_state) ──

  protected langgraphDefaultMergeState(
    state: State,
    messages: any[],
    input: RunAgentInput,
  ): State {
    // Remove leading system messages
    if (
      messages.length > 0 &&
      (messages[0] instanceof SystemMessage ||
        messages[0]._getType?.() === "system")
    ) {
      messages = messages.slice(1);
    }

    const frontendTools: Tool[] = input.tools ?? [];
    const result: State = { ...state, messages };

    if (frontendTools.length > 0) {
      result.tools = frontendTools.map(frontendToolToModelTool);
    }

    return result;
  }

  // ── Main event loop (fully aligned with Python _handle_stream_events) ──

  protected async *_handleStreamEvents(
    input: RunAgentInput & { forwarded_props?: ForwardedProps },
  ): AsyncGenerator<BaseEvent> {
    const threadId = input.threadId ?? uuid();
    const runId = input.runId;
    const frontendTools: Tool[] = input.tools ?? [];
    const frontendToolNames = new Set(frontendTools.map((t) => t.name));
    const forwardedProps: ForwardedProps = (input as any).forwarded_props ?? {};

    // Initialize run metadata
    this.activeRun = {
      id: runId,
      thread_id: threadId,
      mode: "start",
      node_name: null,
      prev_node_name: null,
      has_function_streaming: false,
      model_made_tool_call: false,
      state_reliable: true,
      reasoning_process: null,
      manually_emitted_state: null,
    };

    try {
      const nodeNameInput = forwardedProps.node_name ?? null;

      // Build config
      const config: Record<string, any> = {
        ...this._config,
        configurable: {
          ...((this._config.configurable as any) ?? {}),
          thread_id: threadId,
        },
      };

      // Try to get agent state from checkpoint (if graph supports it)
      let agentState: any = null;
      let usePrepareStream = false;
      try {
        const graph = this.graph as any;
        if (typeof graph.getState === "function") {
          agentState = await graph.getState(config);
          usePrepareStream = true;

          // Detect continue mode
          const resumeInput = forwardedProps.command?.resume ?? null;
          if (
            resumeInput == null &&
            threadId &&
            this.activeRun.node_name !== "__end__" &&
            agentState?.next?.length > 0
          ) {
            this.activeRun.mode = "continue";
          }
        }
      } catch {
        // No checkpoint support — proceed with direct stream
      }

      // Determine stream via prepare_stream or direct
      let streamState: State;
      let stream: AsyncIterable<any>;
      let streamConfig = config;

      if (usePrepareStream && agentState) {
        const prepared = await this.prepareStream(input, agentState, config);

        // Handle early-exit events (e.g. interrupts without resume)
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
        // Direct stream (no checkpoint)
        const messages = toLangChainMessages(input.messages);
        streamState = { messages } as State;

        if (frontendTools.length > 0) {
          streamState.tools = frontendTools.map(frontendToolToModelTool);
        }

        stream = this.graph.streamEvents(streamState, {
          version: "v2" as any,
          ...(Object.keys(this._config).length > 0
            ? { configurable: this._config }
            : {}),
        });
      }

      // Emit RUN_STARTED
      const startEv = this._dispatchEvent({
        type: EventType.RUN_STARTED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);
      if (startEv) yield startEv;

      // Handle initial node change from forwarded_props
      for (const ev of this.handleNodeChange(nodeNameInput as string | null)) {
        yield ev;
      }

      // In case of resume, re-start resumed step
      const resumeInput = forwardedProps.command?.resume ?? null;
      if (resumeInput && this.activeRun.node_name) {
        for (const ev of this.handleNodeChange(this.activeRun.node_name)) {
          yield ev;
        }
      }

      let shouldExit = false;
      let currentGraphState: State = { ...streamState };

      // ── Main stream loop ──
      for await (const event of stream) {
        const eventType = event.event as string;
        const eventName = event.name as string;
        const eventData = event.data;
        const metadata = event.metadata ?? {};

        // ── Subgraph boundary detection ──
        const ns: string = (metadata.langgraph_checkpoint_ns as string) ?? "";
        const nsRoot = ns ? ns.split("|")[0].split(":")[0] : "";
        const currentSubgraph =
          nsRoot && this.subgraphs.has(nsRoot) ? nsRoot : null;

        const subgraphsStreamEnabled =
          forwardedProps.stream_subgraphs !== false;
        let isSubgraphStream = false;
        if (subgraphsStreamEnabled) {
          isSubgraphStream =
            eventType.startsWith("events") ||
            eventType.startsWith("values") ||
            ns.includes("|") ||
            currentSubgraph != null;
        }

        const graphContext = currentSubgraph ?? ROOT_SUBGRAPH_NAME;

        if (isSubgraphStream && currentSubgraph !== this.currentSubgraph) {
          this.currentSubgraph = currentSubgraph as string;
          // Emit snapshots on subgraph boundary change
          for await (const snapEv of this.getStateAndMessagesSnapshots(
            streamConfig,
          )) {
            yield snapEv;
          }
        }

        // ── Error event handling ──
        if (eventType === "error") {
          const errorData = eventData ?? {};
          const errorMessage =
            typeof errorData === "object" ? errorData?.message : null;
          const ev = this._dispatchEvent({
            type: EventType.RUN_ERROR,
            message: errorMessage ?? "Unknown error",
          } as BaseEvent);
          if (ev) yield ev;
          break;
        }

        // ── Node change detection ──
        const currentNodeName: string | undefined = metadata.langgraph_node;
        const eventRunId = event.run_id;
        if (typeof eventRunId === "string" && eventRunId) {
          this.activeRun.id = eventRunId;
        }

        let exitingNode = false;

        // ── on_chain_end state tracking ──
        if (
          eventType === LangGraphEventTypes.OnChainEnd &&
          typeof eventData?.output === "object" &&
          eventData.output !== null
        ) {
          const output = eventData.output;
          Object.assign(currentGraphState, output);
          exitingNode = this.activeRun.node_name === currentNodeName;
          // If output has keys beyond protocol-internal, state is reliable
          if (
            Object.keys(output).some(
              (k) => !["messages", "tools", "ag-ui"].includes(k),
            )
          ) {
            this.activeRun.state_reliable = true;
          }
        }

        // ── Exit detection ──
        shouldExit =
          shouldExit ||
          (eventType === LangGraphEventTypes.OnCustomEvent &&
            eventName === CustomEventNames.Exit);

        // ── Node change ──
        if (currentNodeName && currentNodeName !== this.activeRun.node_name) {
          for (const stepEvent of this.handleNodeChange(currentNodeName)) {
            yield stepEvent;
          }
        }

        // ── predict_state tracking ──
        if (eventType === LangGraphEventTypes.OnChatModelStream) {
          const chunk = eventData?.chunk;
          const toolCallChunks = chunkGet(chunk, "tool_call_chunks") ?? [];
          if (toolCallChunks.length > 0) {
            const first = toolCallChunks[0];
            const firstName = first?.name;
            if (firstName) {
              const predictStateMeta: any[] = metadata.predict_state ?? [];
              const toolUsedToPredictState = predictStateMeta.some(
                (p: any) => (p?.tool ?? p) === firstName,
              );
              if (toolUsedToPredictState) {
                this.activeRun.model_made_tool_call = true;
              }
            }
          }
        }

        // ── State snapshot on node exit / state diff ──
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

          const mmtc = this.activeRun.model_made_tool_call;
          const stateReliable = this.activeRun.state_reliable ?? true;
          const suppressed = exitingNode && (mmtc || !stateReliable);

          if (suppressed) {
            this.activeRun.model_made_tool_call = false;
            if (mmtc) {
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

        // ── RawEvent passthrough ──
        const rawEv = this._dispatchEvent({
          type: EventType.RAW,
          event: event,
        } as BaseEvent);
        if (rawEv) yield rawEv;

        // ── Dispatch individual events ──
        for await (const agUiEvent of this._handleSingleEvent(
          event,
          frontendToolNames,
          currentGraphState,
        )) {
          yield agUiEvent;
        }
      }

      // ── Post-stream: check state for interrupts and final node ──
      try {
        const graph = this.graph as any;
        if (typeof graph.getState === "function") {
          const finalState = await graph.getState(streamConfig);
          const tasks = finalState?.tasks ?? null;
          const interrupts = LangGraphAgent._collectInterrupts(
            tasks ? [...tasks] : null,
          );

          const stateMetadata = finalState?.metadata ?? {};
          const writes = stateMetadata.writes ?? {};
          let nodeName: string | null =
            interrupts.length > 0
              ? (this.activeRun.node_name ?? null)
              : (Object.keys(writes)[0] ?? null);

          const nextNodes = finalState?.next ?? [];
          const isEndNode = nextNodes.length === 0 && interrupts.length === 0;
          nodeName = isEndNode ? "__end__" : nodeName;

          // Emit interrupt events
          for (const interrupt of interrupts) {
            const ev = this._dispatchEvent({
              type: EventType.CUSTOM,
              name: LangGraphEventTypes.OnInterrupt,
              value: dumpJsonSafe(interrupt.value),
            } as BaseEvent);
            if (ev) yield ev;
          }

          // Final node change
          if (this.activeRun.node_name !== nodeName) {
            for (const ev of this.handleNodeChange(nodeName)) {
              yield ev;
            }
          }

          // Final state & messages snapshot
          for await (const ev of this.getStateAndMessagesSnapshots(
            streamConfig,
          )) {
            yield ev;
          }
        }
      } catch {
        // Post-stream state check is best-effort
      }

      // Close open steps
      for (const stepEvent of this.handleNodeChange(null)) {
        yield stepEvent;
      }

      // Emit RUN_FINISHED
      const finishEv = this._dispatchEvent({
        type: EventType.RUN_FINISHED,
        threadId,
        runId: this.activeRun.id,
      } as BaseEvent);
      if (finishEv) yield finishEv;
    } finally {
      this.activeRun = null;
    }
  }

  // ── Single event handler (fully aligned with Python _handle_single_event) ──

  protected async *_handleSingleEvent(
    event: any,
    frontendToolNames: Set<string>,
    currentState?: State,
  ): AsyncGenerator<BaseEvent> {
    if (!this.activeRun) {
      throw new Error("_handleSingleEvent called outside an active run");
    }

    const eventType = event.event as string;
    const eventData = event.data;
    const metadata = event.metadata ?? {};
    const runId = this.activeRun.id;

    // ── on_chat_model_stream ──
    if (eventType === LangGraphEventTypes.OnChatModelStream) {
      const shouldEmitMessages = metadata["emit-messages"] !== false;
      const shouldEmitToolCalls = metadata["emit-tool-calls"] !== false;

      const chunk = eventData?.chunk;
      if (!chunk) return;

      const responseMeta = chunkGet(chunk, "response_metadata") ?? {};
      const toolCallChunks: any[] = chunkGet(chunk, "tool_call_chunks") ?? [];

      if (responseMeta?.finish_reason) return;

      const currentStream = this.getMessageInProgress(runId);
      const hasCurrentStream = !!(currentStream && currentStream.id);
      const toolCallData = toolCallChunks.length > 0 ? toolCallChunks[0] : null;

      // predict_state metadata check
      const predictStateMeta: any[] = metadata.predict_state ?? [];
      let toolCallUsedToPredictState = false;
      if (toolCallData?.name && predictStateMeta.length > 0) {
        toolCallUsedToPredictState = predictStateMeta.some(
          (p: any) => (p?.tool ?? p) === toolCallData.name,
        );
      }

      const isToolCallStartEvent =
        !hasCurrentStream && toolCallData && toolCallData.name;
      const isToolCallArgsEvent =
        hasCurrentStream && currentStream?.tool_call_id && toolCallData?.args;
      const isToolCallEndEvent =
        hasCurrentStream && currentStream?.tool_call_id && !toolCallData;

      if (isToolCallStartEvent || isToolCallEndEvent || isToolCallArgsEvent) {
        this.activeRun.has_function_streaming = true;
      }

      const chunkContent = chunkGet(chunk, "content");
      const chunkId = chunkGet(chunk, "id") ?? uuid();

      // Reasoning handling
      const reasoningData = resolveReasoningContent(chunk);
      const encryptedReasoningData = resolveEncryptedReasoningContent(chunk);

      const messageContent =
        chunkContent !== null && chunkContent !== undefined
          ? resolveMessageContent(chunkContent)
          : null;

      // Use `is not None` semantics: empty string "" is valid content
      const isMessageContentEvent =
        toolCallData == null && messageContent !== null;
      const isMessageEndEvent =
        hasCurrentStream &&
        !currentStream?.tool_call_id &&
        !isMessageContentEvent;

      // Handle reasoning
      if (reasoningData) {
        yield* this.handleReasoningEvent(reasoningData, null);
        return;
      }

      // Handle encrypted reasoning
      if (encryptedReasoningData && this.activeRun.reasoning_process) {
        yield* this.handleReasoningEvent(null, encryptedReasoningData);
        return;
      }

      // Reasoning ended (no more reasoning data but process was active)
      if (!reasoningData && this.activeRun.reasoning_process) {
        yield* this.handleReasoningEvent(null, null);
      }

      // predict_state custom event
      if (toolCallUsedToPredictState) {
        const ev = this._dispatchEvent({
          type: EventType.CUSTOM,
          name: "PredictState",
          value: predictStateMeta,
        } as BaseEvent);
        if (ev) yield ev;
      }

      // ── Tool call END ──
      if (isToolCallEndEvent) {
        const ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId: currentStream!.tool_call_id,
        } as BaseEvent);
        if (ev) yield ev;
        this.messagesInProgress[runId] = null;
        return;
      }

      // ── Message END ──
      if (isMessageEndEvent) {
        const ev = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentStream!.id,
        } as BaseEvent);
        if (ev) yield ev;
        this.messagesInProgress[runId] = null;
        return;
      }

      // ── Tool call START ──
      if (isToolCallStartEvent && shouldEmitToolCalls) {
        const ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId: toolCallData.id ?? uuid(),
          toolCallName: toolCallData.name,
          parentMessageId: chunkId,
        } as BaseEvent);
        if (ev) yield ev;

        this.setMessageInProgress(runId, {
          id: chunkId,
          tool_call_id: toolCallData.id ?? uuid(),
          tool_call_name: toolCallData.name,
        });
        return;
      }

      // ── Tool call ARGS ──
      if (isToolCallArgsEvent && shouldEmitToolCalls) {
        const ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: currentStream!.tool_call_id,
          delta:
            typeof toolCallData.args === "string"
              ? toolCallData.args
              : JSON.stringify(toolCallData.args),
        } as BaseEvent);
        if (ev) yield ev;
        return;
      }

      // ── Text message content ──
      if (isMessageContentEvent && shouldEmitMessages) {
        // Skip empty-string deltas (AG-UI TextMessageContentEvent requires min_length=1)
        if (messageContent === "") return;

        if (!hasCurrentStream) {
          const startEv = this._dispatchEvent({
            type: EventType.TEXT_MESSAGE_START,
            role: "assistant",
            messageId: chunkId,
          } as BaseEvent);
          if (startEv) yield startEv;

          this.setMessageInProgress(runId, {
            id: chunkId,
            tool_call_id: null,
            tool_call_name: null,
          });
        }

        const current = this.getMessageInProgress(runId);
        const contentEv = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: current?.id ?? chunkId,
          delta: messageContent,
        } as BaseEvent);
        if (contentEv) yield contentEv;
        return;
      }

      return;
    }

    // ── on_chat_model_end ──
    if (eventType === LangGraphEventTypes.OnChatModelEnd) {
      const currentStream = this.getMessageInProgress(runId);
      if (currentStream?.tool_call_id) {
        const ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId: currentStream.tool_call_id,
        } as BaseEvent);
        if (ev) {
          this.messagesInProgress[runId] = null;
          yield ev;
        }
      } else if (currentStream?.id) {
        const ev = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentStream.id,
        } as BaseEvent);
        if (ev) {
          this.messagesInProgress[runId] = null;
          yield ev;
        }
      }
      return;
    }

    // ── on_custom_event ──
    if (eventType === LangGraphEventTypes.OnCustomEvent) {
      const customName = event.name as string;
      const customData = eventData;

      if (customName === CustomEventNames.ManuallyEmitMessage) {
        const msgId = customData?.message_id ?? uuid();
        let ev: BaseEvent | null;

        ev = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_START,
          role: "assistant",
          messageId: msgId,
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: msgId,
          delta: contentToString(
            customData?.message ?? customData?.content ?? customData,
          ),
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TEXT_MESSAGE_END,
          messageId: msgId,
        } as BaseEvent);
        if (ev) yield ev;
      } else if (customName === CustomEventNames.ManuallyEmitToolCall) {
        const tcId = customData?.id ?? uuid();
        let ev: BaseEvent | null;

        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId: tcId,
          toolCallName: customData?.name ?? "unknown_tool",
          parentMessageId: tcId,
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: tcId,
          delta:
            typeof customData?.args === "string"
              ? customData.args
              : JSON.stringify(customData?.args ?? {}),
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId: tcId,
        } as BaseEvent);
        if (ev) yield ev;
      } else if (customName === CustomEventNames.ManuallyEmitState) {
        this.activeRun.manually_emitted_state = customData;
        const ev = this._dispatchEvent({
          type: EventType.STATE_SNAPSHOT,
          snapshot: this.getStateSnapshot(customData),
        } as BaseEvent);
        if (ev) yield ev;
      }

      // Always emit as CUSTOM pass-through
      const customEv = this._dispatchEvent({
        type: EventType.CUSTOM,
        name: customName,
        value: customData,
      } as BaseEvent);
      if (customEv) yield customEv;

      return;
    }

    // ── on_tool_end ──
    if (eventType === LangGraphEventTypes.OnToolEnd) {
      const toolCallOutput = eventData?.output;
      if (!toolCallOutput) return;

      // Check if output is a Command
      const isCommand =
        toolCallOutput?.constructor?.name === "Command" ||
        (toolCallOutput?.update && typeof toolCallOutput.update === "object");

      if (isCommand) {
        // Extract ToolMessages from Command.update
        const update = toolCallOutput.update;
        const messages: any[] =
          typeof update === "object" && update !== null
            ? (update.messages ?? [])
            : [];

        const toolMessages = messages.filter(
          (m: any) => m instanceof ToolMessage || m?._getType?.() === "tool",
        );

        for (const toolMsg of toolMessages) {
          const toolCallId = toolMsg.tool_call_id;
          if (!toolCallId) continue;

          if (!this.activeRun.has_function_streaming) {
            let ev: BaseEvent | null;
            ev = this._dispatchEvent({
              type: EventType.TOOL_CALL_START,
              toolCallId,
              toolCallName: toolMsg.name ?? event.name ?? "",
              parentMessageId: toolMsg.id,
            } as BaseEvent);
            if (ev) yield ev;

            ev = this._dispatchEvent({
              type: EventType.TOOL_CALL_ARGS,
              toolCallId,
              delta: jsonSafeStringify(eventData?.input ?? {}),
            } as BaseEvent);
            if (ev) yield ev;

            ev = this._dispatchEvent({
              type: EventType.TOOL_CALL_END,
              toolCallId,
            } as BaseEvent);
            if (ev) yield ev;
          }

          const resultEv = this._dispatchEvent({
            type: EventType.TOOL_CALL_RESULT,
            toolCallId,
            messageId: uuid(),
            content: normalizeToolContent(toolMsg.content),
            role: "tool",
          } as BaseEvent);
          if (resultEv) yield resultEv;
        }

        this.activeRun.model_made_tool_call = false;
        this.activeRun.state_reliable = true;
        this.activeRun.has_function_streaming = false;
        return;
      }

      // Non-Command ToolMessage output
      if (
        !(toolCallOutput instanceof ToolMessage) &&
        toolCallOutput?._getType?.() !== "tool"
      ) {
        // Not a ToolMessage — skip
        return;
      }

      const toolCallId = toolCallOutput.tool_call_id;
      if (!toolCallId) return;

      if (!this.activeRun.has_function_streaming) {
        let ev: BaseEvent | null;
        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: toolCallOutput.name ?? event.name ?? "",
          parentMessageId: toolCallOutput.id,
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_ARGS,
          toolCallId,
          delta: jsonSafeStringify(eventData?.input ?? {}),
        } as BaseEvent);
        if (ev) yield ev;

        ev = this._dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as BaseEvent);
        if (ev) yield ev;
      }

      const resultEv = this._dispatchEvent({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId,
        messageId: uuid(),
        content: normalizeToolContent(toolCallOutput.content),
        role: "tool",
      } as BaseEvent);
      if (resultEv) yield resultEv;

      this.activeRun.model_made_tool_call = false;
      this.activeRun.state_reliable = true;
      this.activeRun.has_function_streaming = false;
      return;
    }

    // ── on_tool_error ──
    if (eventType === LangGraphEventTypes.OnToolError) {
      this.activeRun.model_made_tool_call = false;
      this.activeRun.state_reliable = true;
      this.activeRun.has_function_streaming = false;
      return;
    }
  }
}

// ── Factory functions ──

/**
 * Create an AG-UI agent from a LangGraph prebuilt react agent.
 *
 * This builds a real LangGraph `CompiledStateGraph` using
 * `@langchain/langgraph/prebuilt`'s `createReactAgent`, then wraps it
 * in a `LangGraphAgent`.
 */
export function createReactAgent(config: ReactAgentConfig): LangGraphAgent {
  const {
    createReactAgent: lgCreateReactAgent,
  } = require("@langchain/langgraph/prebuilt");

  const graph = lgCreateReactAgent({
    llm: config.model,
    tools: config.tools ?? [],
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });

  return new LangGraphAgent({
    name: config.name ?? "agent",
    graph,
  });
}

/**
 * Create a supervisor agent using LangGraph's prebuilt supervisor pattern.
 */
export function createSupervisor(config: SupervisorConfig): LangGraphAgent {
  const {
    createReactAgent: lgCreateReactAgent,
  } = require("@langchain/langgraph/prebuilt");

  const allTools = [...(config.tools ?? [])];

  const graph = lgCreateReactAgent({
    llm: config.model,
    tools: allTools,
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });

  return new LangGraphAgent({
    name: config.name ?? "supervisor",
    graph,
  });
}
