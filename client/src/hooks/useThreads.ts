import { useState, useCallback, useEffect } from "react";
import type {
  ChatMessage,
  ChatThread,
  ThreadAgentEvent,
  ThreadSummary,
} from "../types";

const API = "/api/history";

async function parseJsonResponse<T>(res: Response): Promise<T | null> {
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const text = await res.text();

  if (!text) {
    return null;
  }

  return JSON.parse(text) as T;
}

function ensureAssistantMessage(
  messages: ChatMessage[],
  messageId: string,
): ChatMessage[] {
  const existing = messages.find((message) => message.id === messageId);
  if (existing) {
    return messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            role: "assistant",
            isStreaming: true,
          }
        : message,
    );
  }

  return [
    ...messages,
    {
      id: messageId,
      role: "assistant",
      content: "",
      toolCalls: [],
      isStreaming: true,
      createdAt: new Date().toISOString(),
    },
  ];
}

export function updateMessagesWithAgentEvent(
  messages: ChatMessage[],
  event: ThreadAgentEvent,
): ChatMessage[] {
  switch (event.type) {
    case "append_message":
      if (messages.some((message) => message.id === event.message.id)) {
        return messages;
      }
      return [
        ...messages.map((message) => {
          if (
            event.message.role !== "tool" ||
            !event.message.toolCallId ||
            !message.toolCalls?.some(
              (toolCall) => toolCall.id === event.message.toolCallId,
            )
          ) {
            return message;
          }

          return {
            ...message,
            toolCalls: message.toolCalls.map((toolCall) =>
              toolCall.id === event.message.toolCallId
                ? {
                    ...toolCall,
                    complete: true,
                  }
                : toolCall,
            ),
          };
        }),
        event.message,
      ];

    case "assistant_start":
      return ensureAssistantMessage(messages, event.messageId);

    case "assistant_delta":
      return ensureAssistantMessage(messages, event.messageId).map((message) =>
        message.id === event.messageId
          ? {
              ...message,
              content: `${message.content}${event.delta}`,
              isStreaming: true,
            }
          : message,
      );

    case "assistant_end":
      return messages.map((message) =>
        message.id === event.messageId
          ? {
              ...message,
              isStreaming: false,
            }
          : message,
      );

    case "tool_start": {
      return ensureAssistantMessage(messages, event.parentMessageId).map(
        (message) => {
          if (message.id !== event.parentMessageId) return message;
          if (
            message.toolCalls?.some(
              (toolCall) => toolCall.id === event.toolCallId,
            )
          ) {
            return message;
          }

          return {
            ...message,
            toolCalls: [
              ...(message.toolCalls || []),
              {
                id: event.toolCallId,
                type: "function" as const,
                function: {
                  name: event.toolCallName,
                  arguments: "",
                },
                complete: false,
              },
            ],
          };
        },
      );
    }

    case "tool_args":
      return messages.map((message) => {
        if (
          !message.toolCalls?.some(
            (toolCall) => toolCall.id === event.toolCallId,
          )
        ) {
          return message;
        }

        return {
          ...message,
          toolCalls: message.toolCalls.map((toolCall) =>
            toolCall.id === event.toolCallId
              ? {
                  ...toolCall,
                  function: {
                    ...toolCall.function,
                    arguments: event.args,
                  },
                }
              : toolCall,
          ),
        };
      });

    case "tool_end":
      return messages.map((message) => {
        if (
          !message.toolCalls?.some(
            (toolCall) => toolCall.id === event.toolCallId,
          )
        ) {
          return message;
        }

        return {
          ...message,
          toolCalls: message.toolCalls!.map((toolCall) =>
            toolCall.id === event.toolCallId
              ? {
                  ...toolCall,
                  complete: true,
                }
              : toolCall,
          ),
        };
      });

    case "run_complete":
      return messages.map((message) =>
        message.isStreaming
          ? {
              ...message,
              isStreaming: false,
            }
          : message,
      );
  }
}

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
      const data = await parseJsonResponse<ThreadSummary[]>(res);
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch threads:", e);
      setList([]);
    }
  }, []);

  const select = useCallback(async (id: string) => {
    setActiveId(id);
    try {
      const res = await fetch(`${API}/threads/${id}`);
      const thread = await parseJsonResponse<ChatThread>(res);
      if (thread) {
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

  const applyAgentEvent = useCallback(
    (threadId: string, event: ThreadAgentEvent) => {
      setActive((prev) => {
        if (!prev || prev.id !== threadId) return prev;

        return {
          ...prev,
          messages: updateMessagesWithAgentEvent(prev.messages, event),
          updatedAt: new Date().toISOString(),
        };
      });
    },
    [],
  );

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
    [activeId],
  );

  // Refresh active thread from server (after agent run completes)
  const refreshActive = useCallback(
    async (threadId = activeId) => {
      if (!threadId) return;
      try {
        const res = await fetch(`${API}/threads/${threadId}`);
        const thread = await parseJsonResponse<ChatThread>(res);
        if (thread) {
          setActive(thread);
          setActiveId(thread.id);
        }
      } catch (e) {
        console.error("Failed to refresh thread:", e);
      }
      // Also refresh the list
      fetchList();
    },
    [activeId, fetchList],
  );

  // Optimistic update: add a message locally (for immediate UI feedback)
  const addLocalMessage = useCallback((message: ChatThread["messages"][0]) => {
    setActive((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        messages: [...prev.messages, message],
        updatedAt: new Date().toISOString(),
      };
    });
  }, []);

  const refreshList = useCallback(async () => {
    await fetchList();
  }, [fetchList]);

  return {
    list,
    active,
    activeId,
    create,
    select,
    remove,
    refreshActive,
    refreshList,
    addLocalMessage,
    applyAgentEvent,
    fetchList,
  };
}
