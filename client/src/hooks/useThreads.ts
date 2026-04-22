import { useState, useCallback, useEffect } from "react";
import { v4 as uuid } from "uuid";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{ id: string; name: string; args: string }>;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const API_BASE = "/api/history";

export function useThreads() {
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId) || null;

  // Fetch threads on mount
  useEffect(() => {
    fetch(`${API_BASE}/threads`)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data) && data.length > 0) {
          setThreads(data);
          setActiveThreadId(data[0].id);
        }
      })
      .catch(console.error);
  }, []);

  const createThread = useCallback(async () => {
    const res = await fetch(`${API_BASE}/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "New Chat" }),
    });
    const thread: ChatThread = await res.json();
    setThreads((prev) => [thread, ...prev]);
    setActiveThreadId(thread.id);
    return thread;
  }, []);

  const selectThread = useCallback(async (id: string) => {
    setActiveThreadId(id);
    // Fetch full thread with messages
    const res = await fetch(`${API_BASE}/threads/${id}`);
    const thread: ChatThread = await res.json();
    setThreads((prev) => prev.map((t) => (t.id === id ? thread : t)));
  }, []);

  const deleteThread = useCallback(
    async (id: string) => {
      await fetch(`${API_BASE}/threads/${id}`, { method: "DELETE" });
      setThreads((prev) => prev.filter((t) => t.id !== id));
      if (activeThreadId === id) {
        setActiveThreadId(null);
      }
    },
    [activeThreadId]
  );

  const addMessages = useCallback(
    async (threadId: string, messages: ChatMessage[]) => {
      // Save to server
      await fetch(`${API_BASE}/threads/${threadId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messages),
      });
      // Update local state
      setThreads((prev) =>
        prev.map((t) => {
          if (t.id !== threadId) return t;
          const updated = {
            ...t,
            messages: [...(t.messages || []), ...messages],
            updatedAt: new Date().toISOString(),
          };
          // Update title from first user message
          if (t.title === "New Chat") {
            const firstUser = updated.messages.find(
              (m) => m.role === "user"
            );
            if (firstUser) {
              updated.title =
                firstUser.content.slice(0, 50) +
                (firstUser.content.length > 50 ? "..." : "");
            }
          }
          return updated;
        })
      );
    },
    []
  );

  return {
    threads,
    activeThread,
    activeThreadId,
    createThread,
    selectThread,
    deleteThread,
    addMessages,
  };
}
