/**
 * ag-ui-react thread utilities — Thread state management helpers.
 *
 * These provide a pattern for managing thread lists, active threads, and
 * step tracking that can be used directly or wrapped in a custom hook.
 *
 * @packageDocumentation
 */

import { useState, useCallback, useEffect } from "react";
import type {
  ActiveStep,
  ChatMessage,
  ChatThread,
  ThreadAgentEvent,
  ThreadSummary,
} from "./types.js";
import { updateMessagesWithAgentEvent } from "./reducer.js";

function now() {
  return new Date().toISOString();
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
  ) => void;
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
  generateId = defaultGenerateId,
}: UseThreadsOptions = {}): UseThreadsReturn {
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
      const res = await fetch(`${historyApiUrl}/threads`);
      const data = await parseJsonResponse<ThreadSummary[]>(res);
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch threads:", e);
      setList([]);
    }
  }, [historyApiUrl]);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  const loadThread = useCallback(
    async (id: string) => {
      setActiveId(id);
      try {
        const res = await fetch(`${historyApiUrl}/threads/${id}`);
        const thread = await parseJsonResponse<ChatThread>(res);
        if (thread) setActiveThread(thread);
      } catch (e) {
        console.error("Failed to fetch thread:", e);
      }
    },
    [historyApiUrl, setActiveThread],
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
      // Handle step events via dedicated state
      if (event.type === "step_started") {
        setActiveSteps((prev) => [
          ...prev,
          {
            stepName: event.stepName,
            parentStepName: event.parentStepName,
            startedAt: now(),
          },
        ]);
      } else if (event.type === "step_finished") {
        setActiveSteps((prev) =>
          prev.filter((s) => s.stepName !== event.stepName),
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
          updatedAt: now(),
        };
      });
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
      handleThreadEvent(threadId, {
        type: "append_message",
        message: {
          id: generateId(),
          role: "tool",
          content: result,
          toolCallId,
          createdAt: now(),
        },
      });
    },
    [handleThreadEvent, generateId],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${historyApiUrl}/threads/${id}`, { method: "DELETE" });
        setList((prev) => prev.filter((t) => t.id !== id));
        if (activeId === id) setActiveThread(null);
      } catch (e) {
        console.error("Failed to delete thread:", e);
      }
    },
    [activeId, setActiveThread, historyApiUrl],
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
