import { useState, useCallback, useEffect } from "react";
import type {
  ActiveStep,
  ChatMessage,
  ChatThread,
  ThreadAgentEvent,
  ThreadSummary,
} from "../types";

const API = "/api/history";

function now() {
  return new Date().toISOString();
}

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
  metadata: Partial<Pick<ChatMessage, "stepName" | "parentStepName">> = {},
): ChatMessage[] {
  const existing = messages.find((message) => message.id === messageId);
  if (existing) {
    return messages.map((message) =>
      message.id === messageId
        ? {
            ...message,
            role: "assistant",
            isStreaming: true,
            stepName: message.stepName ?? metadata.stepName,
            parentStepName: message.parentStepName ?? metadata.parentStepName,
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
      ...metadata,
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
      return ensureAssistantMessage(messages, event.messageId, {
        stepName: event.stepName,
        parentStepName: event.parentStepName,
      });

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
      return ensureAssistantMessage(messages, event.parentMessageId, {
        stepName: event.stepName,
        parentStepName: event.parentStepName,
      }).map((message) => {
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
                stepName: event.stepName,
                parentStepName: event.parentStepName,
              },
            ],
          };
        });
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
                    arguments: `${toolCall.function.arguments}${event.delta}`,
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

        const toolCalls = message.toolCalls!.map((toolCall) =>
          toolCall.id === event.toolCallId
            ? {
                ...toolCall,
                complete: true,
              }
            : toolCall,
        );

        return {
          ...message,
          toolCalls,
          isStreaming: toolCalls.some((toolCall) => !toolCall.complete),
        };
      });

    // Step events don't affect messages — handled separately via activeSteps
    case "step_started":
    case "step_finished":
      return messages;

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
  useEffect(() => {
    void refreshList();
  }, []);

  const refreshList = useCallback(async () => {
    try {
      const res = await fetch(`${API}/threads`);
      const data = await parseJsonResponse<ThreadSummary[]>(res);
      setList(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error("Failed to fetch threads:", e);
      setList([]);
    }
  }, []);

  const loadThread = useCallback(
    async (id: string) => {
      setActiveId(id);

      try {
        const res = await fetch(`${API}/threads/${id}`);
        const thread = await parseJsonResponse<ChatThread>(res);
        if (thread) {
          setActiveThread(thread);
        }
      } catch (e) {
        console.error("Failed to fetch thread:", e);
      }
    },
    [setActiveThread],
  );

  const select = useCallback(
    async (id: string) => {
      await loadThread(id);
    },
    [loadThread],
  );

  const create = useCallback(async (): Promise<string> => {
    const timestamp = now();
    const thread = {
      id: crypto.randomUUID(),
      title: "New Chat",
      messages: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    setActiveThread(thread);
    return thread.id;
  }, [setActiveThread]);

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

      // Update messages
      updateActiveThread((thread) => {
        if (thread.id !== threadId) {
          return thread;
        }

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
    (message: ChatThread["messages"][0]) => {
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
          id: crypto.randomUUID(),
          role: "tool",
          content: result,
          toolCallId,
          createdAt: now(),
        },
      });
    },
    [handleThreadEvent],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await fetch(`${API}/threads/${id}`, { method: "DELETE" });
        setList((prev) => prev.filter((t) => t.id !== id));
        if (activeId === id) {
          setActiveThread(null);
        }
      } catch (e) {
        console.error("Failed to delete thread:", e);
      }
    },
    [activeId, setActiveThread],
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
