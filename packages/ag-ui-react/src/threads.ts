/**
 * ag-ui-react thread utilities — Thread state management helpers.
 *
 * These provide a pattern for managing thread lists, active threads, and
 * step tracking that can be used directly or wrapped in a custom hook.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useEffect } from "react";
import { flushSync } from "react-dom";
import type {
  ActiveStep,
  AgentEventRecord,
  ChatMessage,
  ChatThread,
  ExecutionContext,
  ThreadAgentEvent,
  ThreadSummary,
} from "./types.js";
import { updateMessagesWithAgentEvent } from "./reducer.js";

function now() {
  return new Date().toISOString();
}

function shouldFlushStreamingEvent(event: ThreadAgentEvent) {
  return (
    event.type === "assistant_start" ||
    event.type === "assistant_delta" ||
    event.type === "assistant_end" ||
    event.type === "tool_start" ||
    event.type === "tool_args" ||
    event.type === "tool_end" ||
    event.type === "tool_result_start" ||
    event.type === "tool_result_delta" ||
    event.type === "tool_result_end"
  );
}

function getEventContext(event: Partial<ExecutionContext>) {
  return {
    ...(event.step ? { step: event.step } : {}),
    ...(event.extra ? { extra: event.extra } : {}),
  };
}

function toAgentEventRecord(
  event: ThreadAgentEvent,
  sequence: number,
): AgentEventRecord | null {
  const base = {
    sequence,
    createdAt: now(),
  };

  switch (event.type) {
    case "assistant_start":
      return {
        ...base,
        type: "TEXT_MESSAGE_START",
        messageId: event.messageId,
        role: "assistant",
        ...getEventContext(event),
      };
    case "assistant_delta":
      return {
        ...base,
        type: "TEXT_MESSAGE_CONTENT",
        messageId: event.messageId,
        delta: event.delta,
        ...getEventContext(event),
      };
    case "assistant_end":
      return {
        ...base,
        type: "TEXT_MESSAGE_END",
        messageId: event.messageId,
        ...getEventContext(event),
      };
    case "tool_start":
      return {
        ...base,
        type: "TOOL_CALL_START",
        parentMessageId: event.parentMessageId,
        toolCallId: event.toolCallId,
        toolCallName: event.toolCallName,
        ...getEventContext(event),
      };
    case "tool_args":
      return {
        ...base,
        type: "TOOL_CALL_ARGS",
        toolCallId: event.toolCallId,
        delta: event.delta,
        ...getEventContext(event),
      };
    case "tool_end":
      return {
        ...base,
        type: "TOOL_CALL_END",
        toolCallId: event.toolCallId,
        ...getEventContext(event),
      };
    case "tool_result_start":
      return {
        ...base,
        type: "TOOL_CALL_RESULT_START",
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        ...getEventContext(event),
      };
    case "tool_result_delta":
      return {
        ...base,
        type: "TOOL_CALL_RESULT_CHUNK",
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        delta: event.delta,
        ...getEventContext(event),
      };
    case "tool_result_end":
      return {
        ...base,
        type: "TOOL_CALL_RESULT_END",
        messageId: event.messageId,
        toolCallId: event.toolCallId,
        ...getEventContext(event),
      };
    case "step_started":
      return {
        ...base,
        type: "STEP_STARTED",
        step: event.step,
        stepName: event.step.name,
        ...getEventContext(event),
      };
    case "step_finished":
      return {
        ...base,
        type: "STEP_FINISHED",
        step: event.step,
        stepName: event.step.name,
        ...getEventContext(event),
      };
    case "reasoning_start":
      return {
        ...base,
        type: "REASONING_START",
        messageId: event.messageId,
        ...getEventContext(event),
      };
    case "reasoning_delta":
      return {
        ...base,
        type: "REASONING_MESSAGE_CONTENT",
        messageId: event.messageId,
        delta: event.delta,
        ...getEventContext(event),
      };
    case "reasoning_end":
      return {
        ...base,
        type: "REASONING_END",
        messageId: event.messageId,
        ...getEventContext(event),
      };
    case "append_message":
      if (event.message.role !== "tool") return null;
      return {
        ...base,
        type: "TOOL_CALL_RESULT",
        messageId: event.message.id,
        content: event.message.content,
        toolCallId: event.message.toolCallId,
        ...getEventContext(event.message),
      };
    case "run_complete":
      return {
        ...base,
        type: "RUN_FINISHED",
        ...getEventContext(event),
      };
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T | null> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as T;
}

// ── Hook options ──

export interface UseThreadsOptions {
  /** Base URL for the history API. Default: "/api/history" */
  historyApiUrl?: string;
  /** Optional headers for history API requests */
  headers?: Record<string, string>;
  /** Generate a unique ID (defaults to crypto.randomUUID) */
  generateId?: () => string;
}

export interface UseThreadsReturn {
  /** All thread summaries */
  list: ThreadSummary[];
  /** Currently active thread (full data) */
  active: ChatThread | null;
  /** ID of the active thread */
  activeId: string | null;
  /** Currently running step(s) for tree display */
  activeSteps: ActiveStep[];
  /** Create a new empty thread and make it active */
  create: () => Promise<string>;
  /** Ensure a thread ID exists (use given or create new) */
  ensureActiveThread: (threadId?: string | null) => Promise<string>;
  /** Select and load a thread by ID */
  select: (id: string) => Promise<void>;
  /** Delete a thread */
  remove: (id: string) => Promise<void>;
  /** Refresh the thread list from the API */
  refreshList: () => Promise<void>;
  /** Manually append a message to the active thread */
  appendMessage: (message: ChatMessage) => void;
  /** Append a tool result message */
  appendToolResult: (
    threadId: string,
    toolCallId: string,
    result: string,
  ) => ChatMessage;
  /** Process a ThreadAgentEvent — updates messages and step tracking */
  handleThreadEvent: (threadId: string, event: ThreadAgentEvent) => void;
}

const defaultGenerateId = () => crypto.randomUUID();

/**
 * React hook for managing thread state with AG-UI event integration.
 *
 * Combines thread CRUD (via history API) with real-time event processing.
 * The `handleThreadEvent` callback applies events to the active thread's
 * messages and manages step tracking for sub-agent tree rendering.
 *
 * ```tsx
 * const threads = useThreads({ historyApiUrl: "/api/history" });
 *
 * // Wire into useAgentChat
 * const chat = useAgentChat({
 *   onThreadEvent: threads.handleThreadEvent,
 * });
 * ```
 */
export function useThreads({
  historyApiUrl = "/api/history",
  headers,
  generateId = defaultGenerateId,
}: UseThreadsOptions = {}): UseThreadsReturn {
  const fetchWithHeaders = useCallback(
    (url: string, init?: RequestInit) => {
      const hasInit = Boolean(init && Object.keys(init).length > 0);
      if (!headers && !hasInit) {
        return fetch(url);
      }

      return fetch(url, {
        ...(init || {}),
        ...(headers
          ? { headers: { ...(init?.headers || {}), ...headers } }
          : {}),
      });
    },
    [headers],
  );

  const [list, setList] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<ChatThread | null>(null);
  const [activeSteps, setActiveSteps] = useState<ActiveStep[]>([]);

  const setActiveThread = useCallback((thread: ChatThread | null) => {
    setActive(thread);
    setActiveId(thread?.id ?? null);
  }, []);

  const updateActiveThread = useCallback(
    (updater: (thread: ChatThread) => ChatThread) => {
      setActive((prev) => (prev ? updater(prev) : prev));
    },
    [],
  );

  // Fetch thread list on mount
  const refreshList = useCallback(async () => {
    try {
      const res = await fetchWithHeaders(`${historyApiUrl}/threads`);
      const data = await parseJsonResponse<ThreadSummary[]>(res);
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch threads:", e);
      setList([]);
    }
  }, [fetchWithHeaders, historyApiUrl]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const loadThread = useCallback(
    async (id: string) => {
      setActiveId(id);
      try {
        const res = await fetchWithHeaders(`${historyApiUrl}/threads/${id}`);
        const thread = await parseJsonResponse<ChatThread>(res);
        if (thread) setActiveThread(thread);
      } catch (e) {
        console.error("Failed to fetch thread:", e);
      }
    },
    [fetchWithHeaders, historyApiUrl, setActiveThread],
  );

  const select = useCallback(
    async (id: string) => {
      await loadThread(id);
    },
    [loadThread],
  );

  const create = useCallback(async (): Promise<string> => {
    const timestamp = now();
    const thread: ChatThread = {
      id: generateId(),
      title: "New Chat",
      messages: [],
      events: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setActiveThread(thread);
    return thread.id;
  }, [setActiveThread, generateId]);

  const ensureActiveThread = useCallback(
    async (threadId?: string | null) => {
      return threadId || create();
    },
    [create],
  );

  const handleThreadEvent = useCallback(
    (threadId: string, event: ThreadAgentEvent) => {
      const applyEvent = () => {
        // Handle step events via dedicated state
        if (event.type === "step_started") {
          setActiveSteps((prev) => {
            const step = event.step;
            if (!step?.name) return prev;
            const alreadyTracked = prev.some(
              (activeStep) =>
                activeStep.step?.id === step.id ||
                (!step.id && activeStep.stepName === step.name),
            );
            if (alreadyTracked) return prev;

            return [
              ...prev,
              {
                stepName: step.name,
                step,
                ...(event.extra ? { extra: event.extra } : {}),
                startedAt: now(),
              },
            ];
          });
        } else if (event.type === "step_finished") {
          if (!event.step?.name) return;
          setActiveSteps((prev) =>
            prev.filter((activeStep) =>
              event.step.id
                ? activeStep.step?.id !== event.step.id
                : activeStep.stepName !== event.step.name,
            ),
          );
        } else if (event.type === "run_complete") {
          setActiveSteps([]);
        }

        // Update messages via the pure reducer
        updateActiveThread((thread) => {
          if (thread.id !== threadId) return thread;

          return {
            ...thread,
            messages: updateMessagesWithAgentEvent(thread.messages, event),
            events: (() => {
              const existing = thread.events ?? [];
              const eventRecord = toAgentEventRecord(event, existing.length);
              return eventRecord ? [...existing, eventRecord] : existing;
            })(),
            updatedAt: now(),
          };
        });
      };

      if (shouldFlushStreamingEvent(event)) {
        flushSync(applyEvent);
        return;
      }

      applyEvent();
    },
    [updateActiveThread],
  );

  const appendMessage = useCallback(
    (message: ChatMessage) => {
      updateActiveThread((thread) => ({
        ...thread,
        messages: [...thread.messages, message],
        updatedAt: now(),
      }));
    },
    [updateActiveThread],
  );

  const appendToolResult = useCallback(
    (threadId: string, toolCallId: string, result: string) => {
      const existingToolMessage =
        active?.messages.find((message) => message.toolCallId === toolCallId) ?? null;
      const toolCall =
        active?.messages
          .flatMap((message) => message.toolCalls ?? [])
          .find((toolCall) => toolCall.id === toolCallId) ?? null;
      const message: ChatMessage = {
        id: existingToolMessage?.id ?? generateId(),
        role: "tool",
        content: result,
        toolCallId,
        ...(toolCall?.step ? { step: toolCall.step } : {}),
        ...(toolCall?.extra ? { extra: toolCall.extra } : {}),
        createdAt: now(),
      };
      handleThreadEvent(threadId, {
        type: "append_message",
        message,
      });
      return message;
    },
    [active?.messages, handleThreadEvent, generateId],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetchWithHeaders(`${historyApiUrl}/threads/${id}`, {
          method: "DELETE",
        });
        setList((prev) => prev.filter((t) => t.id !== id));
        if (activeId === id) setActiveThread(null);
      } catch (e) {
        console.error("Failed to delete thread:", e);
      }
    },
    [activeId, fetchWithHeaders, setActiveThread, historyApiUrl],
  );

  return {
    list,
    active,
    activeId,
    activeSteps,
    create,
    ensureActiveThread,
    select,
    remove,
    refreshList,
    appendMessage,
    appendToolResult,
    handleThreadEvent,
  };
}
