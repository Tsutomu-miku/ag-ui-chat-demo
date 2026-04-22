import { Hono } from "hono";
import { v4 as uuid } from "uuid";

// ============================================================
// Types
// ============================================================

export interface StoredMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  createdAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// In-Memory KV Store
// ============================================================

const store = new Map<string, ChatThread>();

/** Get or create a thread */
export function getOrCreateThread(threadId: string): ChatThread {
  let thread = store.get(threadId);
  if (!thread) {
    thread = {
      id: threadId,
      title: "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.set(threadId, thread);
  }
  return thread;
}

/** Append messages to a thread (called by the agent endpoint after a run) */
export function appendMessages(threadId: string, messages: StoredMessage[]): ChatThread {
  const thread = getOrCreateThread(threadId);
  thread.messages.push(...messages);
  thread.updatedAt = new Date().toISOString();

  // Auto-title from first user message
  if (thread.title === "New Chat") {
    const firstUser = thread.messages.find((m) => m.role === "user");
    if (firstUser) {
      thread.title =
        firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
    }
  }
  return thread;
}

/** Get a thread by ID */
export function getThread(threadId: string): ChatThread | undefined {
  return store.get(threadId);
}

/** Delete a thread */
export function deleteThread(threadId: string): boolean {
  return store.delete(threadId);
}

/** List all threads (summary only) */
export function listThreads() {
  return Array.from(store.values())
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      preview: messages[messages.length - 1]?.content?.slice(0, 100) || "",
    }));
}

// ============================================================
// Hono Router for History API
// ============================================================

export const historyRouter = new Hono();

// List all threads (summaries)
historyRouter.get("/threads", (c) => {
  return c.json(listThreads());
});

// Get full thread with messages
historyRouter.get("/threads/:id", (c) => {
  const thread = getThread(c.req.param("id"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json(thread);
});

// Delete a thread
historyRouter.delete("/threads/:id", (c) => {
  const ok = deleteThread(c.req.param("id"));
  if (!ok) return c.json({ error: "Thread not found" }, 404);
  return c.json({ success: true });
});
