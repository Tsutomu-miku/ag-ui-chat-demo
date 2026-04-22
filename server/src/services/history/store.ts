import type { ToolCall } from "@ag-ui/core";

import { createLogger } from "../../config/logger.js";

export type StoredRole = "user" | "assistant" | "tool";

export interface StoredMessage {
  id: string;
  role: StoredRole;
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  createdAt: string;
}

export interface ChatThread {
  id: string;
  title: string;
  messages: StoredMessage[];
  createdAt: string;
  updatedAt: string;
}

const store = new Map<string, ChatThread>();
const logger = createLogger("history");

function now() {
  return new Date().toISOString();
}

export function getOrCreateThread(threadId: string): ChatThread {
  const existing = store.get(threadId);

  if (existing) {
    return existing;
  }

  const thread = {
    id: threadId,
    title: "New Chat",
    messages: [],
    createdAt: now(),
    updatedAt: now(),
  };

  store.set(threadId, thread);
  logger.debug("thread created", { threadId });
  return thread;
}

export function appendMessages(threadId: string, messages: StoredMessage[]): ChatThread {
  const thread = getOrCreateThread(threadId);

  thread.messages.push(...messages);
  thread.updatedAt = now();

  if (thread.title === "New Chat") {
    const firstUser = thread.messages.find((message) => message.role === "user");

    if (firstUser) {
      thread.title =
        firstUser.content.slice(0, 50) + (firstUser.content.length > 50 ? "..." : "");
    }
  }

  logger.debug("messages appended", {
    threadId,
    appendedCount: messages.length,
    totalCount: thread.messages.length,
  });

  return thread;
}

export function getThread(threadId: string): ChatThread | undefined {
  return store.get(threadId);
}

export function deleteThread(threadId: string): boolean {
  const deleted = store.delete(threadId);

  logger.info("thread delete requested", { threadId, deleted });

  return deleted;
}

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
