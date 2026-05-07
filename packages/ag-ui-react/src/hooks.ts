/**
 * ag-ui-react hooks — Reusable React hooks for AG-UI agent interactions.
 *
 * These hooks encapsulate the AG-UI client subscription pattern and
 * translate AG-UI protocol events into ThreadAgentEvents suitable
 * for driving React state via the reducer.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useRef, useMemo } from "react";
import { HttpAgent } from "@ag-ui/client";
import type { AgentSubscriber } from "@ag-ui/client";
import type {
  ChatMessage,
  ExecutionContext,
  ExecutionOwner,
  ExecutionStep,
  FrontendToolDefinition,
  PendingToolCall,
  ThreadAgentEvent,
} from "./types.js";
import { AG_UI_TRACE_EVENT_NAME } from "./types.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

// ── Event metadata helper ──

function getEventContext(event: unknown): ExecutionContext {
  const item = event as {
    step?: ExecutionStep;
    owner?: ExecutionOwner;
  };
  const step = item.step;
  const owner = item.owner;

  return {
    ...(step ? { step } : {}),
    ...(owner ? { owner } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolResultEventPayload(event: unknown):
  | (ExecutionContext & {
      messageId?: string;
      toolCallId?: string;
      delta?: string;
    })
  | null {
  if (!isRecord(event)) return null;
  const value = isRecord(event.value) ? event.value : null;
  if (!value) return null;
  const root = isRecord(event) ? event : {};

  return {
    ...(typeof value.messageId === "string"
      ? { messageId: value.messageId }
      : {}),
    ...(typeof value.toolCallId === "string"
      ? { toolCallId: value.toolCallId }
      : {}),
    ...(typeof value.delta === "string" ? { delta: value.delta } : {}),
    ...getEventContext({
      ...root,
      ...value,
    }),
  };
}

// ── Hook options ──

export interface UseAgentChatOptions {
  /** Base URL for the AG-UI agent endpoint */
  agentUrl?: string;
  /** Optional request headers passed to HttpAgent */
  headers?: Record<string, string>;
  /** Frontend tools that require user interaction before execution */
  frontendTools?: FrontendToolDefinition[];
  /** Called for each ThreadAgentEvent during a run */
  onThreadEvent?: (threadId: string, event: ThreadAgentEvent) => void;
  /** Generate a unique ID (defaults to crypto.randomUUID) */
  generateId?: () => string;
}

export interface UseAgentChatReturn {
  /** Start a new agent run with the given messages */
  sendMessage: (
    threadId: string,
    messages: ChatMessage[],
    onComplete: () => Promise<void>,
    runInput?: Record<string, unknown>,
  ) => Promise<void>;
  /** Abort the current run */
  stopStreaming: () => void;
  /** Resolve a pending frontend tool call with a result */
  resolveToolCall: (
    toolCallId: string,
    result: string,
    onComplete: () => Promise<void>,
    messages?: ChatMessage[],
  ) => Promise<void>;
  /** Whether a run is currently in progress */
  isStreaming: boolean;
  /** Frontend tool calls awaiting user action */
  pendingToolCalls: PendingToolCall[];
}

const defaultGenerateId = () => crypto.randomUUID();

/**
 * React hook that manages AG-UI agent communication.
 *
 * Wraps `@ag-ui/client`'s `HttpAgent` with a subscriber that emits
 * `ThreadAgentEvent`s via the `onThreadEvent` callback. Consumers
 * feed these events into `updateMessagesWithAgentEvent` to drive
 * their message state.
 *
 * ```tsx
 * const { sendMessage, isStreaming, pendingToolCalls, resolveToolCall } = useAgentChat({
 *   agentUrl: "/api/agent",
 *   frontendTools: MY_TOOLS,
 *   onThreadEvent: (threadId, event) => {
 *     setMessages(prev => updateMessagesWithAgentEvent(prev, event));
 *   },
 * });
 * ```
 */
export function useAgentChat({
  agentUrl = "/api/agent",
  headers,
  frontendTools = [],
  onThreadEvent,
  generateId = defaultGenerateId,
}: UseAgentChatOptions = {}): UseAgentChatReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingToolCalls, setPendingToolCalls] = useState<PendingToolCall[]>(
    [],
  );

  // Track current run context for multi-turn frontend tool calls
  const runContextRef = useRef<{
    threadId: string;
    runInput?: Record<string, unknown>;
  } | null>(null);

  // Persistent HttpAgent instance (re-created only when URL changes)
  const agent = useMemo(
    () => new HttpAgent({ url: agentUrl, headers }),
    [agentUrl, headers],
  );

  // Set of frontend tool names for fast lookup
  const frontendToolNames = useMemo(
    () => new Set(frontendTools.map((t) => t.name)),
    [frontendTools],
  );

  const emitThreadEvent = useCallback(
    (threadId: string, event: ThreadAgentEvent) => {
      onThreadEvent?.(threadId, event);
    },
    [onThreadEvent],
  );

  const sendMessage = useCallback(
    async (
      threadId: string,
      messages: ChatMessage[],
      onComplete: () => Promise<void>,
      runInput?: Record<string, unknown>,
    ) => {
      setIsStreaming(true);
      setPendingToolCalls([]);

      runContextRef.current = { threadId, runInput };

      const pendingFrontend: PendingToolCall[] = [];
      let activeAssistantMessageId: string | null = null;
      const toolContext = new Map<string, ExecutionContext>();

      agent.threadId = threadId;
      agent.messages = messages.map((m) => ({
        id: m.id || generateId(),
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.step ? { step: m.step } : {}),
        ...(m.owner ? { owner: m.owner } : {}),
      })) as never[];

      const subscriber: AgentSubscriber = {
        onTextMessageStartEvent: ({ event }) => {
          activeAssistantMessageId = event.messageId;
          emitThreadEvent(threadId, {
            type: "assistant_start",
            messageId: event.messageId,
            ...getEventContext(event),
          });
        },

        onTextMessageContentEvent: ({ event }) => {
          emitThreadEvent(threadId, {
            type: "assistant_delta",
            messageId: event.messageId,
            delta: event.delta,
          });
        },

        onTextMessageEndEvent: ({ event }) => {
          emitThreadEvent(threadId, {
            type: "assistant_end",
            messageId: event.messageId,
          });
        },

        onToolCallStartEvent: ({ event }) => {
          const parentMessageId =
            event.parentMessageId ||
            activeAssistantMessageId ||
            event.toolCallId;
          const context = getEventContext(event);

          toolContext.set(event.toolCallId, context);

          emitThreadEvent(threadId, {
            type: "tool_start",
            parentMessageId,
            toolCallId: event.toolCallId,
            toolCallName: event.toolCallName,
            ...context,
          });
        },

        onToolCallArgsEvent: ({ event }) => {
          emitThreadEvent(threadId, {
            type: "tool_args",
            toolCallId: event.toolCallId,
            delta: event.delta,
          });
        },

        onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
          emitThreadEvent(threadId, {
            type: "tool_end",
            toolCallId: event.toolCallId,
          });

          if (frontendToolNames.has(toolCallName)) {
            const context = {
              ...(toolContext.get(event.toolCallId) ?? {}),
              ...getEventContext(event),
            };
            const pendingToolCall = {
              toolCallId: event.toolCallId,
              toolCallName,
              args: toolCallArgs,
              status: "pending",
              ...context,
            } satisfies PendingToolCall;
            pendingFrontend.push(pendingToolCall);
            // 前端工具一旦参数流结束，就立刻展示交互卡片；
            // 不要等到 run finalized，否则服务端稍有延迟时 UI 会卡住不显示。
            setPendingToolCalls((prev) => {
              if (
                prev.some(
                  (item) => item.toolCallId === pendingToolCall.toolCallId,
                )
              ) {
                return prev;
              }
              return [...prev, pendingToolCall];
            });
          }
        },

        onToolCallResultEvent: ({ event }) => {
          toolContext.delete(event.toolCallId);
          emitThreadEvent(threadId, {
            type: "append_message",
            message: {
              id: event.messageId,
              role: "tool",
              content: event.content,
              toolCallId: event.toolCallId,
              ...getEventContext(event),
              createdAt: new Date().toISOString(),
            },
          });
        },

        onStepStartedEvent: ({ event }) => {
          const stepEvent = event as { step?: ExecutionStep };
          if (!stepEvent.step?.name) return;
          const { step: _ignoredStep, ...context } = getEventContext(event);
          const step: ExecutionStep & { name: string } = {
            ...(stepEvent.step?.id ? { id: stepEvent.step.id } : {}),
            ...(stepEvent.step?.parentId
              ? { parentId: stepEvent.step.parentId }
              : {}),
            ...(stepEvent.step?.kind ? { kind: stepEvent.step.kind } : {}),
            name: stepEvent.step.name,
          };
          emitThreadEvent(threadId, {
            type: "step_started",
            ...context,
            step,
          });
        },

        onReasoningMessageStartEvent: ({ event }) => {
          const messageId =
            (event as { messageId?: string }).messageId ||
            activeAssistantMessageId ||
            "";
          if (!messageId) return;
          emitThreadEvent(threadId, {
            type: "reasoning_start",
            messageId,
            ...getEventContext(event),
          });
        },

        onReasoningMessageContentEvent: ({ event }) => {
          const messageId =
            (event as { messageId?: string }).messageId ||
            activeAssistantMessageId ||
            "";
          const delta = (event as { delta?: string }).delta || "";
          if (!messageId || !delta) return;
          emitThreadEvent(threadId, {
            type: "reasoning_delta",
            messageId,
            delta,
          });
        },

        onReasoningMessageEndEvent: ({ event }) => {
          const messageId =
            (event as { messageId?: string }).messageId ||
            activeAssistantMessageId ||
            "";
          if (!messageId) return;
          emitThreadEvent(threadId, {
            type: "reasoning_end",
            messageId,
          });
        },

        onStepFinishedEvent: ({ event }) => {
          const stepEvent = event as { step?: ExecutionStep };
          if (!stepEvent.step?.name) return;
          const { step: _ignoredStep, ...context } = getEventContext(event);
          const step: ExecutionStep & { name: string } = {
            ...(stepEvent.step?.id ? { id: stepEvent.step.id } : {}),
            ...(stepEvent.step?.parentId
              ? { parentId: stepEvent.step.parentId }
              : {}),
            ...(stepEvent.step?.kind ? { kind: stepEvent.step.kind } : {}),
            name: stepEvent.step.name,
          };
          emitThreadEvent(threadId, {
            type: "step_finished",
            ...context,
            step,
          });
        },

        onCustomEvent: ({ event }) => {
          if (event.name === TOOL_RESULT_START_EVENT) {
            const payload = getToolResultEventPayload(event);
            if (!payload?.messageId || !payload.toolCallId) return;
            emitThreadEvent(threadId, {
              type: "tool_result_start",
              messageId: payload.messageId,
              toolCallId: payload.toolCallId,
              ...(payload.step ? { step: payload.step } : {}),
              ...(payload.owner ? { owner: payload.owner } : {}),
            });
            return;
          }

          if (event.name === TOOL_RESULT_DELTA_EVENT) {
            const payload = getToolResultEventPayload(event);
            if (!payload?.messageId || !payload.toolCallId || !payload.delta)
              return;
            emitThreadEvent(threadId, {
              type: "tool_result_delta",
              messageId: payload.messageId,
              toolCallId: payload.toolCallId,
              delta: payload.delta,
            });
            return;
          }

          if (event.name === TOOL_RESULT_END_EVENT) {
            const payload = getToolResultEventPayload(event);
            if (!payload?.messageId || !payload.toolCallId) return;
            emitThreadEvent(threadId, {
              type: "tool_result_end",
              messageId: payload.messageId,
              toolCallId: payload.toolCallId,
            });
            return;
          }

          if (event.name !== AG_UI_TRACE_EVENT_NAME) return;
          emitThreadEvent(threadId, {
            type: "trace_event",
            name: event.name,
            value: event.value,
          });
        },

        onRunFinalized: async () => {
          emitThreadEvent(threadId, { type: "run_complete" });

          // 无论是否还有 pending frontend tool，都应该让调用方刷新侧栏/列表，
          // 否则第一轮结束后若 agent 问询用户（pending tool call），新建的
          // thread 永远不会出现在历史列表中。
          if (pendingFrontend.length > 0) {
            setPendingToolCalls(pendingFrontend);
          }
          await onComplete();

          setIsStreaming(false);
        },

        onRunFailed: ({ error }) => {
          emitThreadEvent(threadId, { type: "run_complete" });

          if (error.name !== "AbortError") {
            console.error("[ag-ui-react] Stream error:", error);
          }
          setIsStreaming(false);
        },
      };

      try {
        await agent.runAgent(
          {
            runId: generateId(),
            tools: frontendTools as never[],
            ...(runInput || {}),
          } as never,
          subscriber,
        );
      } catch {
        setIsStreaming(false);
      }
    },
    [agent, emitThreadEvent, frontendToolNames, frontendTools, generateId],
  );

  const resolveToolCall = useCallback(
    async (
      toolCallId: string,
      result: string,
      onComplete: () => Promise<void>,
      messages?: ChatMessage[],
    ) => {
      const ctx = runContextRef.current;
      if (!ctx) return;

      const pending = pendingToolCalls.find(
        (item) => item.toolCallId === toolCallId,
      );
      const toolResultMessage: ChatMessage = {
        id: generateId(),
        role: "tool",
        content: result,
        toolCallId,
        ...(pending?.step ? { step: pending.step } : {}),
        ...(pending?.owner ? { owner: pending.owner } : {}),
        createdAt: new Date().toISOString(),
      };

      setPendingToolCalls((prev) =>
        prev.filter((p) => p.toolCallId !== toolCallId),
      );

      const nextMessages =
        Array.isArray(messages) && messages.length > 0
          ? messages
          : [toolResultMessage];
      const nextRunInput = {
        ...(ctx.runInput || {}),
        forwardedProps: {
          ...(((ctx.runInput || {}).forwardedProps as Record<
            string,
            unknown
          >) || {}),
          frontendToolResume: {
            toolCallId,
          },
        },
      };

      await sendMessage(ctx.threadId, nextMessages, onComplete, nextRunInput);
    },
    [sendMessage, generateId, pendingToolCalls],
  );

  const stopStreaming = useCallback(() => {
    agent.abortRun();
  }, [agent]);

  return {
    sendMessage,
    stopStreaming,
    resolveToolCall,
    isStreaming,
    pendingToolCalls,
  };
}
