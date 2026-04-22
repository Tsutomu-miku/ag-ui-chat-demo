import { useState, useCallback, useRef } from "react";
import { v4 as uuid } from "uuid";
import type { FrontendToolDefinition, PendingToolCall } from "../types";

// ============================================================
// Frontend Tool Definitions
//
// These tools require user interaction before execution.
// The agent sees them and can call them. When it does,
// the frontend shows a UI for the user to interact with.
// ============================================================

export const FRONTEND_TOOLS: FrontendToolDefinition[] = [
  {
    name: "confirm_action",
    description: "Ask the user to confirm or reject a proposed action before proceeding. Use this when you are about to perform something important or irreversible.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Description of the action to confirm",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How critical this action is",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "collect_user_input",
    description: "Ask the user to provide additional information via a text input. Use when you need more details to complete a task.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or prompt to show the user",
        },
        placeholder: {
          type: "string",
          description: "Placeholder text for the input field",
        },
      },
      required: ["prompt"],
    },
  },
];

// ============================================================
// AG-UI Event Types (for SSE parsing)
// ============================================================

interface AGUIEvent {
  type: string;
  [key: string]: any;
}

// ============================================================
// Hook
// ============================================================

interface UseAgentChatOptions {
  agentUrl?: string;
}

const STREAM_REVEAL_INTERVAL_MS = 12;

export function useAgentChat({ agentUrl = "/api/agent" }: UseAgentChatOptions = {}) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<
    Array<{ id: string; name: string; args: string; complete: boolean }>
  >([]);
  const [pendingToolCalls, setPendingToolCalls] = useState<PendingToolCall[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  // Track current run context for multi-turn tool calls
  const runContextRef = useRef<{
    threadId: string;
  } | null>(null);

  /**
   * Parse AG-UI SSE stream from the server.
   * Uses @ag-ui/encoder format: each line is `data: {JSON}\n\n`
   */
  const parseSSEStream = async function* (
    response: Response
  ): AsyncGenerator<AGUIEvent> {
    const reader = response.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() || "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed.startsWith("data: ")) continue;
        try {
          yield JSON.parse(trimmed.slice(6));
        } catch {
          // skip malformed events
        }
      }
    }

    const trimmed = buffer.trim();
    if (trimmed.startsWith("data: ")) {
      try {
        yield JSON.parse(trimmed.slice(6));
      } catch {
        // skip malformed event
      }
    }
  };

  /**
   * Send a message to the AG-UI agent endpoint.
   * 
   * @param threadId - The conversation thread ID
   * @param messages - New messages for this run. The backend hydrates thread history.
   * @param onComplete - Called when the run finishes (for refreshing history)
   */
  const sendMessage = useCallback(
    async (
      threadId: string,
      messages: any[],
      onComplete: () => Promise<void>
    ) => {
      setIsStreaming(true);
      setStreamingContent("");
      setStreamingToolCalls([]);
      setPendingToolCalls([]);

      const abortController = new AbortController();
      abortRef.current = abortController;

      // Save context for potential multi-turn frontend tool calls
      runContextRef.current = { threadId };

      let revealedContent = "";
      let queuedCharacters: string[] = [];
      let revealTimer: ReturnType<typeof setTimeout> | null = null;
      let resolveRevealIdle: (() => void) | null = null;
      let revealIdlePromise = Promise.resolve();
      const toolCalls: Array<{ id: string; name: string; args: string; complete: boolean }> = [];
      const toolCallArgsMap = new Map<string, string>();
      const frontendToolNames = new Set(FRONTEND_TOOLS.map((t) => t.name));
      const pendingFrontend: PendingToolCall[] = [];

      function ensureRevealIdlePromise() {
        if (!resolveRevealIdle) {
          revealIdlePromise = new Promise<void>((resolve) => {
            resolveRevealIdle = resolve;
          });
        }
      }

      function resolveRevealIfDone() {
        if (queuedCharacters.length === 0 && !revealTimer && resolveRevealIdle) {
          resolveRevealIdle();
          resolveRevealIdle = null;
        }
      }

      function revealNextCharacter() {
        revealTimer = null;

        const next = queuedCharacters.shift();
        if (next !== undefined) {
          revealedContent += next;
          setStreamingContent(revealedContent);
        }

        if (queuedCharacters.length > 0) {
          scheduleReveal();
        } else {
          resolveRevealIfDone();
        }
      }

      function scheduleReveal() {
        if (revealTimer || queuedCharacters.length === 0) return;

        ensureRevealIdlePromise();
        revealTimer = setTimeout(revealNextCharacter, STREAM_REVEAL_INTERVAL_MS);
      }

      function appendStreamingDelta(delta: string) {
        if (!delta) return;

        queuedCharacters.push(...Array.from(delta));
        ensureRevealIdlePromise();
        scheduleReveal();
      }

      async function waitForStreamingReveal() {
        if (queuedCharacters.length === 0 && !revealTimer) return;
        await revealIdlePromise;
      }

      function cancelStreamingReveal() {
        if (revealTimer) {
          clearTimeout(revealTimer);
          revealTimer = null;
        }

        queuedCharacters = [];
        if (resolveRevealIdle) {
          resolveRevealIdle();
          resolveRevealIdle = null;
        }
      }

      try {
        const response = await fetch(agentUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            threadId,
            runId: uuid(),
            messages,
            // Pass frontend tool definitions to the agent
            tools: FRONTEND_TOOLS,
            context: [],
            forwardedProps: {},
            state: undefined,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new Error(`Server error: ${response.status} ${response.statusText}`);
        }

        // Process AG-UI events from SSE stream
        for await (const event of parseSSEStream(response)) {
          switch (event.type) {
            case "RUN_STARTED":
              break;

            case "TEXT_MESSAGE_START":
              break;

            case "TEXT_MESSAGE_CONTENT":
            case "TEXT_MESSAGE_CHUNK":
              appendStreamingDelta(event.delta || event.content || "");
              break;

            case "TEXT_MESSAGE_END":
              break;

            case "TOOL_CALL_START": {
              const tc = {
                id: event.toolCallId,
                name: event.toolCallName,
                args: "",
                complete: false,
              };
              toolCalls.push(tc);
              toolCallArgsMap.set(event.toolCallId, "");
              setStreamingToolCalls([...toolCalls]);
              break;
            }

            case "TOOL_CALL_ARGS": {
              const prev = toolCallArgsMap.get(event.toolCallId) || "";
              const updated = prev + (event.delta || "");
              toolCallArgsMap.set(event.toolCallId, updated);
              const idx = toolCalls.findIndex((t) => t.id === event.toolCallId);
              if (idx >= 0) toolCalls[idx].args = updated;
              setStreamingToolCalls([...toolCalls]);
              break;
            }

            case "TOOL_CALL_END": {
              const idx = toolCalls.findIndex((t) => t.id === event.toolCallId);
              if (idx >= 0) {
                toolCalls[idx].complete = true;
                setStreamingToolCalls([...toolCalls]);

                // Check if this is a frontend tool call
                if (frontendToolNames.has(toolCalls[idx].name)) {
                  let parsedArgs = {};
                  try {
                    parsedArgs = JSON.parse(toolCalls[idx].args);
                  } catch {}
                  pendingFrontend.push({
                    toolCallId: toolCalls[idx].id,
                    toolCallName: toolCalls[idx].name,
                    args: parsedArgs,
                    status: "pending",
                  });
                }
              }
              break;
            }

            case "RUN_FINISHED":
              break;

            case "RUN_ERROR":
              throw new Error(event.message || "Agent run failed");
          }
        }

        await waitForStreamingReveal();

        // If there are pending frontend tool calls, set them for the UI
        if (pendingFrontend.length > 0) {
          setPendingToolCalls(pendingFrontend);
          // Don't call onComplete yet - wait for tool resolution
        } else {
          // No frontend tool calls - run is fully complete
          await onComplete();
        }
      } catch (error: any) {
        if (error.name !== "AbortError") {
          console.error("[AG-UI] Stream error:", error);
        }
      } finally {
        cancelStreamingReveal();
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingToolCalls([]);
        abortRef.current = null;
      }
    },
    [agentUrl]
  );

  /**
   * Resolve a frontend tool call (user has approved/rejected/provided input).
   * Sends a NEW request to the agent with the tool result in messages.
   *
   * This is the AG-UI multi-turn protocol:
   * 1. First request: agent returns TOOL_CALL events for a frontend tool
   * 2. Frontend shows UI, user interacts
   * 3. Second request: sends the tool result; the backend hydrates prior messages
   */
  const resolveToolCall = useCallback(
    async (
      toolCallId: string,
      result: string,
      onComplete: () => Promise<void>
    ) => {
      const ctx = runContextRef.current;
      if (!ctx) return;

      // Build the tool result message
      const toolResultMessage = {
        id: uuid(),
        role: "tool",
        content: result,
        toolCallId,
      };

      // Clear pending
      setPendingToolCalls((prev) => prev.filter((p) => p.toolCallId !== toolCallId));

      await sendMessage(ctx.threadId, [toolResultMessage], onComplete);
    },
    [sendMessage]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    sendMessage,
    stopStreaming,
    resolveToolCall,
    isStreaming,
    streamingContent,
    streamingToolCalls,
    pendingToolCalls,
  };
}
