import { useState, useCallback, useEffect } from "react";
import type { ChatThread, ThreadSummary } from "../types";

const API = "/api/history";

export function useThreads() {
  const [list, setList] = useState<ThreadSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [active, setActive] = useState<ChatThread | null>(null);

  // Fetch thread list on mount
  useEffect(() => {
    fetchList();
  }, []);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch(`${API}/threads`);
      const data = await res.json();
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch threads:", e);
    }
  }, []);

  const select = useCallback(async (id: string) => {
    setActiveId(id);
    try {
      const res = await fetch(`${API}/threads/${id}`);
      if (res.ok) {
        const thread = await res.json();
        setActive(thread);
      }
    } catch (e) {
      console.error("Failed to fetch thread:", e);
    }
  }, []);

  const create = useCallback(async (): Promise<string> => {
    // Just generate a new threadId - the backend will create the thread
    // when the first agent request arrives
    const id = crypto.randomUUID();
    setActiveId(id);
    setActive({
      id,
      title: "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    return id;
  }, []);

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API}/threads/${id}`, { method: "DELETE" });
        setList((prev) => prev.filter((t) => t.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setActive(null);
        }
      } catch (e) {
        console.error("Failed to delete thread:", e);
      }
    },
    [activeId]
  );

  // Refresh active thread from server (after agent run completes)
  const refreshActive = useCallback(async (threadId = activeId) => {
    if (!threadId) return;
    try {
      const res = await fetch(`${API}/threads/${threadId}`);
      if (res.ok) {
        const thread = await res.json();
        setActive(thread);
        setActiveId(thread.id);
      }
    } catch (e) {
      console.error("Failed to refresh thread:", e);
    }
    // Also refresh the list
    fetchList();
  }, [activeId, fetchList]);

  // Optimistic update: add a message locally (for immediate UI feedback)
  const addLocalMessage = useCallback(
    (message: ChatThread["messages"][0]) => {
      setActive((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: [...prev.messages, message],
          updatedAt: new Date().toISOString(),
        };
      });
    },
    []
  );

  return {
    list,
    active,
    activeId,
    create,
    select,
    remove,
    refreshActive,
    addLocalMessage,
    fetchList,
  };
}
