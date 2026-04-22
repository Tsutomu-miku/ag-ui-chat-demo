import { useState, useCallback, useRef } from "react";
import { v4 as uuid } from "uuid";
import type { ChatMessage } from "./useThreads";

interface UseAgentChatOptions {
  agentUrl?: string;
}

export function useAgentChat(
  { agentUrl = "/api/agent" }: UseAgentChatOptions = {}
) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingToolCalls, setStreamingToolCalls] = useState<
    Array<{ id: string; name: string; args: string }>
  >([]);
  const abortRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback(
    async (
      threadId: string,
      messages: Array<{ role: string; content: string; id?: string }>,
      onComplete: (message: ChatMessage) => void
    ) => {
      setIsStreaming(true);
      setStreamingContent("");
      setStreamingToolCalls([]);

      const runId = uuid();
      let fullContent = "";
      let messageId = "";
      const toolCalls: Array<{ id: string; name: string; args: string }> = [];
      const toolCallArgsMap = new Map<string, string>();

      try {
        const response = await fetch(agentUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify({
            threadId,
            runId,
            messages: messages.map((m) => ({
              id: m.id || uuid(),
              role: m.role,
              content: m.content,
            })),
            tools: [],
            context: [],
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error("No response body");

        const decoder = new TextDecoder();
        let buffer = "";

        abortRef.current = () => reader.cancel();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const dataLine = line.trim();
            if (!dataLine.startsWith("data: ")) continue;

            try {
              const event = JSON.parse(dataLine.slice(6)) as Record<
                string,
                any
              >;

              switch (event.type) {
                case "RUN_STARTED":
                  break;

                case "TEXT_MESSAGE_START":
                  messageId = event.messageId || uuid();
                  break;

                case "TEXT_MESSAGE_CONTENT":
                  fullContent += event.delta || "";
                  setStreamingContent(fullContent);
                  break;

                case "TEXT_MESSAGE_END":
                  break;

                case "TOOL_CALL_START":
                  toolCalls.push({
                    id: event.toolCallId,
                    name: event.toolCallName,
                    args: "",
                  });
                  toolCallArgsMap.set(event.toolCallId, "");
                  setStreamingToolCalls([...toolCalls]);
                  break;

                case "TOOL_CALL_ARGS": {
                  const existing =
                    toolCallArgsMap.get(event.toolCallId) || "";
                  const updated = existing + (event.delta || "");
                  toolCallArgsMap.set(event.toolCallId, updated);
                  const tcIdx = toolCalls.findIndex(
                    (tc) => tc.id === event.toolCallId
                  );
                  if (tcIdx >= 0) toolCalls[tcIdx].args = updated;
                  setStreamingToolCalls([...toolCalls]);
                  break;
                }

                case "TOOL_CALL_END":
                  break;

                case "RUN_FINISHED":
                  break;

                case "RUN_ERROR":
                  throw new Error(event.message || "Agent run failed");
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }

        // Build the final assistant message
        const finalMessage: ChatMessage = {
          id: messageId || uuid(),
          role: "assistant",
          content: fullContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          createdAt: new Date().toISOString(),
        };

        onComplete(finalMessage);
      } catch (error: any) {
        console.error("AG-UI stream error:", error);
        const errorMessage: ChatMessage = {
          id: uuid(),
          role: "assistant",
          content: `Error: ${error.message}`,
          createdAt: new Date().toISOString(),
        };
        onComplete(errorMessage);
      } finally {
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingToolCalls([]);
        abortRef.current = null;
      }
    },
    [agentUrl]
  );

  const stopStreaming = useCallback(() => {
    abortRef.current?.();
  }, []);

  return {
    sendMessage,
    stopStreaming,
    isStreaming,
    streamingContent,
    streamingToolCalls,
  };
}
