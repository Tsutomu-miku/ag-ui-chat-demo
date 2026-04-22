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
  FrontendToolDefinition,
  PendingToolCall,
  ThreadAgentEvent,
} from "./types.js";

// ── Event metadata helper ──

type EventStepMetadata = Partial<{
  stepName: string;
  parentStepName: string;
}>;

function getEventStepMetadata(event: unknown): EventStepMetadata {
  const item = event as EventStepMetadata;
  return {
    ...(item.stepName ? { stepName: item.stepName } : {}),
    ...(item.parentStepName ? { parentStepName: item.parentStepName } : {}),
  };
}

// ── Hook options ──

export interface UseAgentChatOptions {
  /** Base URL for the AG-UI agent endpoint */
  agentUrl?: string;
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
    messages: Array<Record<string, unknown>>,
    onComplete: () => Promise<void>,
  ) => Promise<void>;
  /** Abort the current run */
  stopStreaming: () => void;
  /** Resolve a pending frontend tool call with a result */
  resolveToolCall: (
    toolCallId: string,
    result: string,
    onComplete: () => Promise<void>,
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
  frontendTools = [],
  onThreadEvent,
  generateId = defaultGenerateId,
}: UseAgentChatOptions = {}): UseAgentChatReturn {
  const [isStreaming, setIsStreaming] = useState(false);
  const [pendingToolCalls, setPendingToolCalls] = useState<PendingToolCall[]>(
    [],
  );

  // Track current run context for multi-turn frontend tool calls
  const runContextRef = useRef<{ threadId: string } | null>(null);

  // Persistent HttpAgent instance (re-created only when URL changes)
  const agent = useMemo(() => new HttpAgent({ url: agentUrl }), [agentUrl]);

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
      messages: Array<Record<string, unknown>>,
      onComplete: () => Promise<void>,
    ) => {
      setIsStreaming(true);
      setPendingToolCalls([]);

      runContextRef.current = { threadId };

      const pendingFrontend: PendingToolCall[] = [];
      let activeAssistantMessageId: string | null = null;

      agent.threadId = threadId;
      agent.messages = messages.map((m) => ({
        id: (m.id as string) ?? generateId(),
        role: m.role as string,
        content: m.content as string,
        ...(m.toolCallId ? { toolCallId: m.toolCallId as string } : {}),
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

          emitThreadEvent(threadId, {
            type: "tool_start",
            parentMessageId,
            toolCallId: event.toolCallId,
            toolCallName: event.toolCallName,
            ...getEventStepMetadata(event),
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
            pendingFrontend.push({
              toolCallId: event.toolCallId,
              toolCallName,
              args: toolCallArgs,
              status: "pending",
              ...getEventStepMetadata(event),
            });
          }
        },

        onToolCallResultEvent: ({ event }) => {
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
          const { parentStepName } = getEventStepMetadata(event);
          emitThreadEvent(threadId, {
            type: "step_started",
            stepName: event.stepName,
            ...(parentStepName ? { parentStepName } : {}),
          });
        },

        onStepFinishedEvent: ({ event }) => {
          const { parentStepName } = getEventStepMetadata(event);
          emitThreadEvent(threadId, {
            type: "step_finished",
            stepName: event.stepName,
            ...(parentStepName ? { parentStepName } : {}),
          });
        },

        onRunFinalized: async () => {
          emitThreadEvent(threadId, { type: "run_complete" });

          if (pendingFrontend.length > 0) {
            setPendingToolCalls(pendingFrontend);
          } else {
            await onComplete();
          }

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
    ) => {
      const ctx = runContextRef.current;
      if (!ctx) return;

      const toolResultMessage = {
        id: generateId(),
        role: "tool",
        content: result,
        toolCallId,
      };

      setPendingToolCalls((prev) =>
        prev.filter((p) => p.toolCallId !== toolCallId),
      );

      await sendMessage(ctx.threadId, [toolResultMessage], onComplete);
    },
    [sendMessage, generateId],
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
