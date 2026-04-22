import { useState, useRef, useEffect, useCallback } from "react";
import { v4 as uuid } from "uuid";
import { useAgentChat } from "../hooks/useAgentChat";
import { MessageBubble } from "./MessageBubble";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { FrontendToolUI } from "./FrontendToolUI";
import type { ChatThread, ThreadAgentEvent } from "../types";

interface ChatPanelProps {
  thread: ChatThread | null;
  threadActions: {
    create: () => Promise<string>;
    refreshActive: (threadId?: string) => Promise<void>;
    refreshList: () => Promise<void>;
    addLocalMessage: (msg: ChatThread["messages"][0]) => void;
    applyAgentEvent: (threadId: string, event: ThreadAgentEvent) => void;
  };
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function ChatPanel({
  thread,
  threadActions,
  sidebarOpen,
  onToggleSidebar,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    sendMessage,
    stopStreaming,
    resolveToolCall,
    isStreaming,
    pendingToolCalls,
  } = useAgentChat({
    onThreadEvent: threadActions.applyAgentEvent,
  });

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages, pendingToolCalls]);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }, [input]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    let threadId = thread?.id;
    if (!threadId) {
      threadId = await threadActions.create();
    }

    const userMsg = {
      id: uuid(),
      role: "user" as const,
      content: text,
      createdAt: new Date().toISOString(),
    };

    setInput("");

    // Optimistic UI: show user message immediately
    threadActions.addLocalMessage(userMsg);

    await sendMessage(
      threadId,
      [
        {
          id: userMsg.id,
          role: userMsg.role,
          content: userMsg.content,
        },
      ],
      async () => {
        // Keep the current message tree stable and only refresh sidebar metadata.
        await threadActions.refreshList();
      },
    );
  }, [input, isStreaming, thread, threadActions, sendMessage]);

  const handleToolResult = useCallback(
    async (toolCallId: string, result: string) => {
      if (!thread?.id) return;

      threadActions.applyAgentEvent(thread.id, {
        type: "append_message",
        message: {
          id: uuid(),
          role: "tool",
          content: result,
          toolCallId,
          createdAt: new Date().toISOString(),
        },
      });

      await resolveToolCall(toolCallId, result, async () => {
        await threadActions.refreshList();
      });
    },
    [resolveToolCall, thread, threadActions],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const hasMessages = thread && thread.messages.length > 0;
  const hasStreamingMessage =
    thread?.messages.some((msg) => msg.isStreaming) ?? false;
  const hasActiveToolCall =
    thread?.messages.some((msg) =>
      msg.toolCalls?.some((toolCall) => !toolCall.complete),
    ) ?? false;
  const toolResultById = new Map<string, string>(
    (thread?.messages || [])
      .filter((msg) => msg.role === "tool" && msg.toolCallId)
      .map((msg) => [msg.toolCallId as string, msg.content]),
  );
  const toolCallIds = new Set(
    (thread?.messages || []).flatMap((msg) =>
      (msg.toolCalls || []).map((toolCall) => toolCall.id),
    ),
  );
  const visibleMessages = (thread?.messages || []).filter(
    (msg) =>
      msg.role !== "tool" ||
      !msg.toolCallId ||
      !toolCallIds.has(msg.toolCallId),
  );

  return (
    <main className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        {!sidebarOpen && (
          <button
            className="icon-btn"
            onClick={onToggleSidebar}
            title="Open sidebar"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
        )}
        <h3>{thread?.title || "AG-UI Chat Demo"}</h3>
        <div className="header-badge">AG-UI Protocol</div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {!hasMessages && !isStreaming && (
          <div className="welcome-screen">
            <div className="welcome-icon">🤖</div>
            <h2>AG-UI Chat Demo</h2>
            <p>
              Best-practice demonstration of the AG-UI protocol with LangChain
            </p>
            <div className="feature-grid">
              <div
                className="feature-card"
                onClick={() => setInput("What's the weather like in Tokyo?")}
              >
                <span className="feature-emoji">🌤</span>
                <span>
                  Weather lookup
                  <br />
                  <small>Backend tool</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  setInput("Search for the latest news about AI agents")
                }
              >
                <span className="feature-emoji">🔍</span>
                <span>
                  Web search
                  <br />
                  <small>Backend tool</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() => setInput("Calculate (23 * 45) + (67 / 3)")}
              >
                <span className="feature-emoji">🧮</span>
                <span>
                  Math calculator
                  <br />
                  <small>Backend tool</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  setInput(
                    "I need to deploy the production server, please confirm this action",
                  )
                }
              >
                <span className="feature-emoji">✅</span>
                <span>
                  Confirm action
                  <br />
                  <small>Frontend tool</small>
                </span>
              </div>
            </div>
            <p className="welcome-sub">
              <strong>Backend tools</strong> execute on the server.{" "}
              <strong>Frontend tools</strong> require your interaction.
            </p>
          </div>
        )}

        {visibleMessages.map((msg) => (
          <div key={msg.id}>
            <MessageBubble message={msg} isStreaming={msg.isStreaming} />
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <ToolCallDisplay
                toolCalls={msg.toolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.function.name,
                  args: tc.function.arguments,
                  complete: tc.complete ?? true,
                  result: toolResultById.get(tc.id),
                }))}
                isStreaming={msg.isStreaming}
              />
            )}
          </div>
        ))}

        {isStreaming && !hasStreamingMessage && !hasActiveToolCall && (
          <div className="message assistant">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="typing-indicator">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        )}

        {/* Frontend tool interaction UI */}
        {pendingToolCalls.length > 0 && (
          <FrontendToolUI
            pendingToolCalls={pendingToolCalls}
            onResolve={handleToolResult}
          />
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-container">
        <div className="input-wrapper">
          <textarea
            ref={textareaRef}
            className="message-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            rows={1}
            disabled={isStreaming || pendingToolCalls.length > 0}
          />
          {isStreaming ? (
            <button
              className="send-btn stop"
              onClick={stopStreaming}
              title="Stop generating"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
              title="Send message"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          )}
        </div>
        <p className="input-hint">
          Enter to send · Shift+Enter for new line · Frontend tools require your
          confirmation
        </p>
      </div>
    </main>
  );
}
