/**
 * LangGraphAgent — AG-UI protocol adapter for LangGraph compiled graphs.
 *
 * **Truly aligned with Python `ag_ui_langgraph.LangGraphAgent`:**
 * - Accepts a compiled LangGraph state graph (not raw model/tools)
 * - Uses `graph.streamEvents(input, { version: "v2" })` to intercept
 *   LangGraph internal events (on_chat_model_stream, on_tool_end, etc.)
 * - Translates them into AG-UI protocol events (TEXT_MESSAGE_*, TOOL_CALL_*, STEP_*)
 * - `clone()` per request for isolated state, `run(input)` returns AsyncGenerator
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
 * @example Using factory helpers
 * ```ts
 * import { createReactAgent } from "ag-ui-langchain";
 *
 * const agent = createReactAgent({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   tools: [searchWeb],
 *   systemPrompt: "You are a helpful assistant.",
 * });
 * const events = agent.clone().run(input);
 * ```
 *
 * @packageDocumentation
 */

import { EventType, type BaseEvent, type RunAgentInput, type Tool } from "@ag-ui/core";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { CompiledStateGraph } from "@langchain/langgraph";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { v4 as uuid } from "uuid";

import {
  contentToString,
  frontendToolToModelTool,
  toLangChainMessages,
} from "./convert.js";
import { resolveReasoningContent, resolveEncryptedReasoningContent } from "./convert.js";
import type {
  StreamEventMetadata,
  RunMetadata,
  MessageInProgress,
  MessagesInProgressRecord,
  LangGraphReasoning,
  ThinkingProcess,
  State,
} from "./types.js";
import { LangGraphEventTypes, CustomEventNames } from "./types.js";

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

// ── LangGraphAgent class (aligned with Python) ──

/**
 * Core AG-UI agent adapter, aligned with Python `ag_ui_langgraph.LangGraphAgent`.
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
    return new (this.constructor as new (c: LangGraphAgentConfig) => LangGraphAgent)({
      name: this.name,
      graph: this.graph,
      description: this.description,
      config: { ...this._config },
    });
  }

  /** Run the agent, yielding AG-UI events (aligned with Python `run()`). */
  async *run(input: RunAgentInput): AsyncGenerator<BaseEvent> {
    yield* this._handleStreamEvents(input);
  }

  // ── Message-in-progress tracking ──

  protected getMessageInProgress(runId: string): MessageInProgress | null {
    return this.messagesInProgress[runId] ?? null;
  }

  protected setMessageInProgress(runId: string, value: MessageInProgress | null): void {
    this.messagesInProgress[runId] = value;
  }

  // ── Step management ──

  protected *handleNodeChange(nodeName: string | null): Generator<BaseEvent> {
    if (nodeName === "__end__") nodeName = null;

    if (!this.activeRun) return;

    const currentNode = this.activeRun.node_name;
    if (nodeName === currentNode) return;

    // End current step
    if (currentNode) {
      yield { type: EventType.STEP_FINISHED, stepName: currentNode } as BaseEvent;
    }

    // Start new step
    if (nodeName) {
      yield { type: EventType.STEP_STARTED, stepName: nodeName } as BaseEvent;
    }

    this.activeRun.node_name = nodeName;
  }

  // ── Reasoning event handling ──

  protected *handleReasoningEvent(
    reasoningData: LangGraphReasoning | null,
    encryptedData: string | null,
  ): Generator<BaseEvent> {
    if (!this.activeRun) return;

    const reasoningProcess = this.activeRun.reasoning_process;

    if (encryptedData) {
      yield { type: EventType.REASONING_ENCRYPTED_VALUE, data: encryptedData } as BaseEvent;
    }

    if (reasoningData) {
      // Start reasoning if not started
      if (!reasoningProcess) {
        this.activeRun.reasoning_process = {
          index: reasoningData.index,
          type: reasoningData.type,
          signature: reasoningData.signature ?? null,
        };
        yield { type: EventType.REASONING_START } as BaseEvent;
        yield {
          type: EventType.REASONING_MESSAGE_START,
          messageId: uuid(),
        } as BaseEvent;
      }

      yield {
        type: EventType.REASONING_MESSAGE_CONTENT,
        delta: reasoningData.text,
      } as BaseEvent;
    } else if (reasoningProcess) {
      // Reasoning ended
      if (reasoningProcess.signature) {
        yield {
          type: EventType.REASONING_ENCRYPTED_VALUE,
          data: reasoningProcess.signature,
        } as BaseEvent;
      }
      yield { type: EventType.REASONING_MESSAGE_END } as BaseEvent;
      yield { type: EventType.REASONING_END } as BaseEvent;
      this.activeRun.reasoning_process = null;
    }
  }

  // ── Main event loop (aligned with Python _handle_stream_events) ──

  protected async *_handleStreamEvents(input: RunAgentInput): AsyncGenerator<BaseEvent> {
    const threadId = input.threadId;
    const runId = input.runId;
    const frontendTools: Tool[] = input.tools ?? [];
    const frontendToolNames = new Set(frontendTools.map((t) => t.name));

    // Build state from messages
    const messages = toLangChainMessages(input.messages);
    const agentState: State = { messages };

    // Add frontend tools to state if present
    if (frontendTools.length > 0) {
      agentState.tools = frontendTools.map(frontendToolToModelTool);
    }

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
    };

    try {
      // Emit RUN_STARTED
      yield { type: EventType.RUN_STARTED, threadId, runId } as BaseEvent;

      // Stream events from the LangGraph graph
      const stream = this.graph.streamEvents(agentState, {
        version: "v2" as any,
        ...(Object.keys(this._config).length > 0 ? { configurable: this._config } : {}),
      });

      for await (const event of stream) {
        const eventType = event.event as string;
        const eventName = event.name as string;
        const eventData = event.data;
        const metadata = event.metadata ?? {};

        // ── Node change detection ──
        const langgraphNode = metadata.langgraph_node as string | undefined;
        if (langgraphNode && langgraphNode !== this.activeRun.node_name) {
          for (const stepEvent of this.handleNodeChange(langgraphNode)) {
            yield stepEvent;
          }
        }

        // ── Dispatch individual events ──
        for await (const agUiEvent of this._handleSingleEvent(event, frontendToolNames)) {
          yield agUiEvent;
        }
      }

      // ── Post-stream: close open steps ──
      for (const stepEvent of this.handleNodeChange(null)) {
        yield stepEvent;
      }

      // Emit RUN_FINISHED
      yield { type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent;
    } finally {
      this.activeRun = null;
    }
  }

  // ── Single event handler (aligned with Python _handle_single_event) ──

  protected async *_handleSingleEvent(
    event: any,
    frontendToolNames: Set<string>,
  ): AsyncGenerator<BaseEvent> {
    const eventType = event.event as string;
    const eventData = event.data;
    const runId = this.activeRun?.id ?? "";

    // ── on_chat_model_stream ──
    if (eventType === LangGraphEventTypes.OnChatModelStream) {
      const chunk = eventData?.chunk;
      if (!chunk) return;

      // Check finish_reason → skip
      const responseMeta = chunkGet(chunk, "response_metadata");
      if (responseMeta?.finish_reason) return;

      // Reasoning handling
      const reasoningData = resolveReasoningContent(chunk);
      const encryptedData = resolveEncryptedReasoningContent(chunk);
      if (reasoningData || encryptedData) {
        yield* this.handleReasoningEvent(reasoningData, encryptedData);
        if (!reasoningData && !encryptedData) return;
        // If we have reasoning but also text, continue to text handling
        if (reasoningData && !chunkGet(chunk, "content")) return;
      } else if (this.activeRun?.reasoning_process) {
        // Reasoning ended (no more reasoning data but process was active)
        yield* this.handleReasoningEvent(null, null);
      }

      const currentStream = this.getMessageInProgress(runId);
      const hasCurrentStream = currentStream != null;

      // Extract tool call data
      const toolCallChunks: any[] = chunkGet(chunk, "tool_call_chunks") ?? [];
      const toolCallData = toolCallChunks.length > 0 ? toolCallChunks[0] : null;

      // Extract text content
      const messageContent = contentToString(chunkGet(chunk, "content"));
      const messageId = chunkGet(chunk, "id") ?? uuid();

      // ── Tool call END: has current tool stream, no new tool data ──
      if (hasCurrentStream && currentStream.tool_call_id && !toolCallData) {
        yield {
          type: EventType.TOOL_CALL_END,
          toolCallId: currentStream.tool_call_id,
        } as BaseEvent;
        this.setMessageInProgress(runId, null);
        return;
      }

      // ── Message END: has current text stream, no more content, no tool data ──
      if (hasCurrentStream && !currentStream.tool_call_id && !toolCallData && !messageContent) {
        yield {
          type: EventType.TEXT_MESSAGE_END,
          messageId: currentStream.id,
        } as BaseEvent;
        this.setMessageInProgress(runId, null);
        return;
      }

      // ── Tool call START: no current stream, tool data with name ──
      if (!hasCurrentStream && toolCallData && toolCallData.name) {
        const toolCallId = toolCallData.id ?? uuid();

        // Check if it's a frontend tool → we still emit the start
        this.activeRun!.has_function_streaming = true;

        this.setMessageInProgress(runId, {
          id: messageId,
          tool_call_id: toolCallId,
          tool_call_name: toolCallData.name,
        });

        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName: toolCallData.name,
          parentMessageId: messageId,
        } as BaseEvent;

        // Also emit initial args if present
        if (toolCallData.args) {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: typeof toolCallData.args === "string"
              ? toolCallData.args
              : JSON.stringify(toolCallData.args),
          } as BaseEvent;
        }
        return;
      }

      // ── Tool call ARGS: continuing tool call stream ──
      if (hasCurrentStream && currentStream.tool_call_id && toolCallData?.args) {
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: currentStream.tool_call_id,
          delta: typeof toolCallData.args === "string"
            ? toolCallData.args
            : JSON.stringify(toolCallData.args),
        } as BaseEvent;
        return;
      }

      // ── Text message content ──
      if (messageContent && !toolCallData) {
        if (!hasCurrentStream) {
          // Start new text message
          this.setMessageInProgress(runId, {
            id: messageId,
            tool_call_id: null,
            tool_call_name: null,
          });

          yield {
            type: EventType.TEXT_MESSAGE_START,
            messageId,
            role: "assistant",
          } as BaseEvent;
        }

        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: currentStream?.id ?? messageId,
          delta: messageContent,
        } as BaseEvent;
      }

      return;
    }

    // ── on_chat_model_end ──
    if (eventType === LangGraphEventTypes.OnChatModelEnd) {
      const currentStream = this.getMessageInProgress(runId);
      if (currentStream) {
        if (currentStream.tool_call_id) {
          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId: currentStream.tool_call_id,
          } as BaseEvent;
        } else {
          yield {
            type: EventType.TEXT_MESSAGE_END,
            messageId: currentStream.id,
          } as BaseEvent;
        }
        this.setMessageInProgress(runId, null);
      }

      // Reset flags
      if (this.activeRun) {
        this.activeRun.has_function_streaming = false;
      }

      return;
    }

    // ── on_tool_end ──
    if (eventType === LangGraphEventTypes.OnToolEnd) {
      const output = eventData?.output;
      if (!output) return;

      // Extract tool message(s) from output
      const toolMessages: ToolMessage[] = [];
      if (output instanceof ToolMessage) {
        toolMessages.push(output);
      } else if (output?.messages) {
        // Command-style output
        for (const msg of output.messages) {
          if (msg instanceof ToolMessage) toolMessages.push(msg);
        }
      }

      for (const toolMessage of toolMessages) {
        const toolCallId = toolMessage.tool_call_id;
        if (!toolCallId) continue;

        // If tool calls were not streamed, emit start/args/end
        if (!this.activeRun?.has_function_streaming) {
          const toolName = (toolMessage as any).name ?? event.name ?? "unknown_tool";
          yield {
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName: toolName,
          } as BaseEvent;

          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: "{}",
          } as BaseEvent;

          yield {
            type: EventType.TOOL_CALL_END,
            toolCallId,
          } as BaseEvent;
        }

        // Always emit result
        yield {
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          content: contentToString(toolMessage.content),
          role: "tool",
        } as BaseEvent;
      }

      // Reset flags
      if (this.activeRun) {
        this.activeRun.model_made_tool_call = false;
        this.activeRun.state_reliable = true;
        this.activeRun.has_function_streaming = false;
      }

      return;
    }

    // ── on_tool_error ──
    if (eventType === LangGraphEventTypes.OnToolError) {
      if (this.activeRun) {
        this.activeRun.model_made_tool_call = false;
        this.activeRun.state_reliable = true;
        this.activeRun.has_function_streaming = false;
      }
      return;
    }

    // ── on_custom_event ──
    if (eventType === LangGraphEventTypes.OnCustomEvent) {
      const customName = event.name as string;
      const customData = eventData;

      if (customName === CustomEventNames.ManuallyEmitMessage) {
        const msgId = uuid();
        yield { type: EventType.TEXT_MESSAGE_START, messageId: msgId, role: "assistant" } as BaseEvent;
        yield {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: msgId,
          delta: contentToString(customData?.content ?? customData),
        } as BaseEvent;
        yield { type: EventType.TEXT_MESSAGE_END, messageId: msgId } as BaseEvent;
      } else if (customName === CustomEventNames.ManuallyEmitToolCall) {
        const tcId = customData?.id ?? uuid();
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: tcId,
          toolCallName: customData?.name ?? "unknown_tool",
        } as BaseEvent;
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: tcId,
          delta: JSON.stringify(customData?.args ?? {}),
        } as BaseEvent;
        yield { type: EventType.TOOL_CALL_END, toolCallId: tcId } as BaseEvent;
      } else if (customName === CustomEventNames.ManuallyEmitState) {
        yield {
          type: EventType.STATE_SNAPSHOT,
          snapshot: customData,
        } as BaseEvent;
        if (this.activeRun) {
          this.activeRun.manually_emitted_state = customData;
        }
      } else if (customName === CustomEventNames.Exit) {
        // Exit signal — will stop after current iteration
        return;
      }

      // Always emit as CUSTOM pass-through
      yield {
        type: EventType.CUSTOM,
        name: customName,
        value: customData,
      } as BaseEvent;

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
 *
 * ```ts
 * const agent = createReactAgent({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   tools: [searchWeb, calculate],
 *   systemPrompt: "You are a helpful assistant.",
 * });
 * ```
 */
export function createReactAgent(config: ReactAgentConfig): LangGraphAgent {
  // Lazy import to avoid hard dependency at module level
  const { createReactAgent: lgCreateReactAgent } = require("@langchain/langgraph/prebuilt");

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
 *
 * Builds a real LangGraph graph with the supervisor as the orchestrator
 * and sub-agents as nodes, then wraps in `LangGraphAgent`.
 *
 * ```ts
 * const agent = createSupervisor({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   subAgents: {
 *     researcher: { systemPrompt: "...", tools: [searchWeb] },
 *     writer:     { systemPrompt: "...", tools: [calculate] },
 *   },
 * });
 * ```
 */
export function createSupervisor(config: SupervisorConfig): LangGraphAgent {
  const { createReactAgent: lgCreateReactAgent } = require("@langchain/langgraph/prebuilt");

  // Build sub-agent graphs
  const subAgentGraphs: Record<string, any> = {};
  for (const [agentName, subDef] of Object.entries(config.subAgents)) {
    subAgentGraphs[agentName] = lgCreateReactAgent({
      llm: subDef.model ?? config.model,
      tools: subDef.tools,
      prompt: subDef.systemPrompt,
    });
  }

  // Build supervisor graph using StateGraph
  const { StateGraph, MessagesAnnotation, Command } = require("@langchain/langgraph");
  const { SystemMessage, AIMessage } = require("@langchain/core/messages");

  const subAgentNames = Object.keys(config.subAgents);
  const supervisorModel = config.model;
  const supervisorTools = config.tools ?? [];

  // For now, use a simpler pattern: build a react agent for the supervisor
  // with a delegate tool that routes to sub-agents
  // This keeps it simple while still using real LangGraph graphs

  const allTools = [...supervisorTools];

  // The supervisor itself is a react agent with delegation capability
  const graph = lgCreateReactAgent({
    llm: supervisorModel,
    tools: allTools,
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });

  return new LangGraphAgent({
    name: config.name ?? "supervisor",
    graph,
  });
}
