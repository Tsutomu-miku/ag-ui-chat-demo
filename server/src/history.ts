import { Hono } from "hono";
import { v4 as uuid } from "uuid";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface ChatThread {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

// In-memory KV store
const threads = new Map<string, ChatThread>();

export const historyRouter = new Hono();

// List all threads
historyRouter.get("/threads", (c) => {
  const list = Array.from(threads.values())
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .map(({ id, title, createdAt, updatedAt, messages }) => ({
      id,
      title,
      createdAt,
      updatedAt,
      messageCount: messages.length,
      lastMessage: messages[messages.length - 1]?.content?.slice(0, 100),
    }));
  return c.json(list);
});

// Get a thread by ID
historyRouter.get("/threads/:id", (c) => {
  const thread = threads.get(c.req.param("id"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);
  return c.json(thread);
});

// Create a new thread
historyRouter.post("/threads", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const id = uuid();
  const thread: ChatThread = {
    id,
    title: body.title || "New Chat",
    messages: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  threads.set(id, thread);
  return c.json(thread, 201);
});

// Add messages to a thread
historyRouter.post("/threads/:id/messages", async (c) => {
  const thread = threads.get(c.req.param("id"));
  if (!thread) return c.json({ error: "Thread not found" }, 404);

  const body = await c.req.json();
  const messages: ChatMessage[] = (Array.isArray(body) ? body : [body]).map(
    (m: any) => ({
      id: m.id || uuid(),
      role: m.role,
      content: m.content,
      createdAt: m.createdAt || new Date().toISOString(),
    })
  );

  thread.messages.push(...messages);
  thread.updatedAt = new Date().toISOString();

  // Auto-update title from first user message
  if (thread.title === "New Chat" && messages.length > 0) {
    const firstUserMsg = thread.messages.find((m) => m.role === "user");
    if (firstUserMsg) {
      thread.title =
        firstUserMsg.content.slice(0, 50) +
        (firstUserMsg.content.length > 50 ? "..." : "");
    }
  }

  return c.json(thread);
});

// Delete a thread
historyRouter.delete("/threads/:id", (c) => {
  const deleted = threads.delete(c.req.param("id"));
  if (!deleted) return c.json({ error: "Thread not found" }, 404);
  return c.json({ success: true });
});
