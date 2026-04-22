import { useState, useCallback, useRef, useMemo } from "react";
import { v4 as uuid } from "uuid";
import { HttpAgent } from "@ag-ui/client";
import type { AgentSubscriber } from "@ag-ui/client";
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
    description:
      "Ask the user to confirm or reject a proposed action before proceeding. Use this when you are about to perform something important or irreversible.",
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
    description:
      "Ask the user to provide additional information via a text input. Use when you need more details to complete a task.",
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
// Hook
// ============================================================

interface UseAgentChatOptions {
  agentUrl?: string;
}

/** Streaming tool-call state exposed to the UI layer. */
interface StreamingToolCall {
  id: string;
  name: string;
  args: string;
  complete: boolean;
}

export function useAgentChat(
  { agentUrl = "/api/agent" }: UseAgentChatOptions = {},
) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<
    StreamingToolCall[]
  >([]);
  const [pendingToolCalls, setPendingToolCalls] = useState<PendingToolCall[]>(
    [],
  );

  // Track current run context for multi-turn frontend tool calls
  const runContextRef = useRef<{ threadId: string } | null>(null);

  // Persistent HttpAgent instance (re-created only when the URL changes)
  const agent = useMemo(() => new HttpAgent({ url: agentUrl }), [agentUrl]);

  // Set of frontend tool names for fast lookup
  const frontendToolNames = useMemo(
    () => new Set(FRONTEND_TOOLS.map((t) => t.name)),
    [],
  );

  /**
   * Send a message to the AG-UI agent endpoint.
   *
   * @param threadId  – The conversation thread ID
   * @param messages  – New messages for this run (backend hydrates history)
   * @param onComplete – Called when the run finishes without pending frontend tools
   */
  const sendMessage = useCallback(
    async (
      threadId: string,
      messages: Array<Record<string, unknown>>,
      onComplete: () => Promise<void>,
    ) => {
      setIsStreaming(true);
      setStreamingContent("");
      setStreamingToolCalls([]);
      setPendingToolCalls([]);

      // Save context for potential multi-turn frontend tool calls
      runContextRef.current = { threadId };

      // Mutable accumulators scoped to this run — captured by subscriber closures
      const toolCalls: StreamingToolCall[] = [];
      const pendingFrontend: PendingToolCall[] = [];

      // Configure the agent for this run
      agent.threadId = threadId;
      agent.messages = messages.map((m) => ({
        id: (m.id as string) ?? uuid(),
        role: m.role as string,
        content: m.content as string,
        ...(m.toolCallId ? { toolCallId: m.toolCallId as string } : {}),
      })) as never[];

      const abortController = new AbortController();

      // Build the subscriber that drives React state
      const subscriber: AgentSubscriber = {
        // --- Text streaming ---
        // Each SSE chunk fires this callback with the accumulated buffer,
        // so the UI updates character-by-character naturally — no manual
        // reveal queue needed.
        onTextMessageContentEvent: ({ textMessageBuffer }) => {
          setStreamingContent(textMessageBuffer);
        },

        // --- Tool call lifecycle ---
        onToolCallStartEvent: ({ event }) => {
          toolCalls.push({
            id: event.toolCallId,
            name: event.toolCallName,
            args: "",
            complete: false,
          });
          setStreamingToolCalls([...toolCalls]);
        },

        onToolCallArgsEvent: ({ event, toolCallBuffer }) => {
          const idx = toolCalls.findIndex((t) => t.id === event.toolCallId);
          if (idx >= 0) {
            toolCalls[idx].args = toolCallBuffer;
            setStreamingToolCalls([...toolCalls]);
          }
        },

        onToolCallEndEvent: ({ event, toolCallName, toolCallArgs }) => {
          const idx = toolCalls.findIndex((t) => t.id === event.toolCallId);
          if (idx >= 0) {
            toolCalls[idx].complete = true;
            setStreamingToolCalls([...toolCalls]);

            // Detect frontend tool calls that need user interaction
            if (frontendToolNames.has(toolCallName)) {
              pendingFrontend.push({
                toolCallId: event.toolCallId,
                toolCallName,
                args: toolCallArgs,
                status: "pending",
              });
            }
          }
        },

        // --- Run lifecycle ---
        onRunFinalized: async () => {
          if (pendingFrontend.length > 0) {
            // Frontend tool calls detected — show UI, don't call onComplete yet
            setPendingToolCalls(pendingFrontend);
          } else {
            await onComplete();
          }

          setIsStreaming(false);
          setStreamingContent("");
          setStreamingToolCalls([]);
        },

        onRunFailed: ({ error }) => {
          if (error.name !== "AbortError") {
            console.error("[AG-UI] Stream error:", error);
          }
        },
      };

      try {
        await agent.runAgent(
          {
            runId: uuid(),
            tools: FRONTEND_TOOLS as never[],
            abortController,
          } as never,
          subscriber,
        );
      } catch {
        // Errors already handled by onRunFailed subscriber
      }
    },
    [agent, frontendToolNames],
  );

  /**
   * Resolve a frontend tool call after user interaction.
   *
   * This is the AG-UI multi-turn protocol:
   * 1. First request  → agent returns TOOL_CALL events for a frontend tool
   * 2. Frontend shows UI → user interacts
   * 3. Second request → sends the tool result; backend hydrates prior messages
   */
  const resolveToolCall = useCallback(
    async (
      toolCallId: string,
      result: string,
      onComplete: () => Promise<void>,
    ) => {
      const ctx = runContextRef.current;
      if (!ctx) return;

      const toolResultMessage = {
        id: uuid(),
        role: "tool",
        content: result,
        toolCallId,
      };

      // Clear the resolved tool call from pending
      setPendingToolCalls((prev) =>
        prev.filter((p) => p.toolCallId !== toolCallId),
      );

      await sendMessage(ctx.threadId, [toolResultMessage], onComplete);
    },
    [sendMessage],
  );

  const stopStreaming = useCallback(() => {
    agent.abortRun();
  }, [agent]);

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
