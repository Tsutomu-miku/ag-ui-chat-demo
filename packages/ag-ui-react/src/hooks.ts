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
  FrontendToolDefinition,
  PendingToolCall,
  ThreadAgentEvent,
} from "./types.js";
import { AG_UI_TRACE_EVENT_NAME } from "./types.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

// ── Event metadata helper ──

type EventStepMetadata = Partial<{
  stepId: string;
  parentStepId: string;
  stepKind: string;
  stepName: string;
  parentStepName: string;
}>;

function getEventStepMetadata(event: unknown): EventStepMetadata {
  const item = event as EventStepMetadata;
  return {
    ...(item.stepId ? { stepId: item.stepId } : {}),
    ...(item.parentStepId ? { parentStepId: item.parentStepId } : {}),
    ...(item.stepKind ? { stepKind: item.stepKind } : {}),
    ...(item.stepName ? { stepName: item.stepName } : {}),
    ...(item.parentStepName ? { parentStepName: item.parentStepName } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getToolResultEventPayload(
  event: unknown,
): (EventStepMetadata & {
  messageId?: string;
  toolCallId?: string;
  delta?: string;
}) | null {
  if (!isRecord(event)) return null;
  const value = isRecord(event.value) ? event.value : null;
  if (!value) return null;

  return {
    ...(typeof value.messageId === "string" ? { messageId: value.messageId } : {}),
    ...(typeof value.toolCallId === "string"
      ? { toolCallId: value.toolCallId }
      : {}),
    ...(typeof value.delta === "string" ? { delta: value.delta } : {}),
    ...getEventStepMetadata(value),
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
      const toolStepMetadata = new Map<string, EventStepMetadata>();

      agent.threadId = threadId;
      agent.messages = messages.map((m) => ({
        id: m.id || generateId(),
        role: m.role,
        content: m.content,
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.toolCalls ? { toolCalls: m.toolCalls } : {}),
        ...(m.stepId ? { stepId: m.stepId } : {}),
        ...(m.parentStepId ? { parentStepId: m.parentStepId } : {}),
        ...(m.stepKind ? { stepKind: m.stepKind } : {}),
        ...(m.stepName ? { stepName: m.stepName } : {}),
        ...(m.parentStepName ? { parentStepName: m.parentStepName } : {}),
      })) as never[];

      const subscriber: AgentSubscriber = {
        onTextMessageStartEvent: ({ event }) => {
          activeAssistantMessageId = event.messageId;
          emitThreadEvent(threadId, {
            type: "assistant_start",
            messageId: event.messageId,
            ...getEventStepMetadata(event),
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
          const metadata = getEventStepMetadata(event);

          toolStepMetadata.set(event.toolCallId, metadata);

          emitThreadEvent(threadId, {
            type: "tool_start",
            parentMessageId,
            toolCallId: event.toolCallId,
            toolCallName: event.toolCallName,
            ...metadata,
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
            const metadata = {
              ...(toolStepMetadata.get(event.toolCallId) ?? {}),
              ...getEventStepMetadata(event),
            };
            const pendingToolCall = {
              toolCallId: event.toolCallId,
              toolCallName,
              args: toolCallArgs,
              status: "pending",
              ...metadata,
            } satisfies PendingToolCall;
            pendingFrontend.push(pendingToolCall);
            // 前端工具一旦参数流结束，就立刻展示交互卡片；
            // 不要等到 run finalized，否则服务端稍有延迟时 UI 会卡住不显示。
            setPendingToolCalls((prev) => {
              if (prev.some((item) => item.toolCallId === pendingToolCall.toolCallId)) {
                return prev;
              }
              return [...prev, pendingToolCall];
            });
          }
        },

        onToolCallResultEvent: ({ event }) => {
          toolStepMetadata.delete(event.toolCallId);
          emitThreadEvent(threadId, {
            type: "append_message",
            message: {
              id: event.messageId,
              role: "tool",
              content: event.content,
              toolCallId: event.toolCallId,
              ...getEventStepMetadata(event),
              createdAt: new Date().toISOString(),
            },
          });
        },

        onStepStartedEvent: ({ event }) => {
          const metadata = getEventStepMetadata(event);
          emitThreadEvent(threadId, {
            type: "step_started",
            stepName: event.stepName,
            ...metadata,
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
            ...getEventStepMetadata(event),
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
          const metadata = getEventStepMetadata(event);
          emitThreadEvent(threadId, {
            type: "step_finished",
            stepName: event.stepName,
            ...metadata,
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
              stepId: payload.stepId,
              parentStepId: payload.parentStepId,
              stepKind: payload.stepKind,
              stepName: payload.stepName,
              parentStepName: payload.parentStepName,
            });
            return;
          }

          if (event.name === TOOL_RESULT_DELTA_EVENT) {
            const payload = getToolResultEventPayload(event);
            if (!payload?.messageId || !payload.toolCallId || !payload.delta) return;
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
      const metadata = pending
        ? {
            ...(pending.stepId ? { stepId: pending.stepId } : {}),
            ...(pending.parentStepId
              ? { parentStepId: pending.parentStepId }
              : {}),
            ...(pending.stepKind ? { stepKind: pending.stepKind } : {}),
            ...(pending.stepName ? { stepName: pending.stepName } : {}),
            ...(pending.parentStepName
              ? { parentStepName: pending.parentStepName }
              : {}),
          }
        : {};
      const toolResultMessage: ChatMessage = {
        id: generateId(),
        role: "tool",
        content: result,
        toolCallId,
        ...metadata,
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
          ...(((ctx.runInput || {}).forwardedProps as Record<string, unknown>) ||
            {}),
          frontendToolResume: {
            toolCallId,
          },
        },
      };

      await sendMessage(
        ctx.threadId,
        nextMessages,
        onComplete,
        nextRunInput,
      );
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
