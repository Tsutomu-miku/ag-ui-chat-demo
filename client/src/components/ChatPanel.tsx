import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAgentChat } from "../hooks/useAgentChat";
import { MessageBubble } from "./MessageBubble";
import { ToolCallDisplay } from "./ToolCallDisplay";
import type { ChatMessage, ChatThread } from "../hooks/useThreads";
import { v4 as uuid } from "uuid";

interface ChatPanelProps {
  thread: ChatThread | null;
  onSendMessage: (threadId: string, messages: ChatMessage[]) => Promise<void>;
  onNewChat: () => Promise<ChatThread>;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}

export function ChatPanel({
  thread,
  onSendMessage,
  onNewChat,
  sidebarOpen,
  onToggleSidebar,
}: ChatPanelProps) {
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    sendMessage,
    stopStreaming,
    isStreaming,
    streamingContent,
    streamingToolCalls,
  } = useAgentChat();

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [thread?.messages, streamingContent, scrollToBottom]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;

    let currentThread = thread;
    if (!currentThread) {
      currentThread = await onNewChat();
    }

    const userMessage: ChatMessage = {
      id: uuid(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };

    setInput("");

    // Save user message to history
    await onSendMessage(currentThread.id, [userMessage]);

    // Build the full message array for the agent
    const allMessages = [
      ...(currentThread.messages || []),
      userMessage,
    ].map((m) => ({
      role: m.role,
      content: m.content,
      id: m.id,
    }));

    // Send to the AG-UI agent endpoint
    sendMessage(
      currentThread.id,
      allMessages,
      async (assistantMessage) => {
        await onSendMessage(currentThread!.id, [assistantMessage]);
      }
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <main className="chat-panel">
      <div className="chat-header">
        {!sidebarOpen && (
          <button
            className="icon-btn"
            onClick={onToggleSidebar}
            title="Open sidebar"
          >
            \u2630
          </button>
        )}
        <h3>{thread?.title || "AG-UI Chat Demo"}</h3>
        <div className="header-badge">AG-UI Protocol</div>
      </div>

      <div className="messages-container">
        {(!thread || thread.messages.length === 0) && !isStreaming && (
          <div className="welcome-screen">
            <div className="welcome-icon">\u{1F916}</div>
            <h2>AG-UI Chat Demo</h2>
            <p>A best-practice demonstration of the AG-UI protocol</p>
            <div className="feature-grid">
              <div className="feature-card">
                <span className="feature-emoji">\u{1F324}</span>
                <span>Ask about weather</span>
              </div>
              <div className="feature-card">
                <span className="feature-emoji">\u{1F50D}</span>
                <span>Search the web</span>
              </div>
              <div className="feature-card">
                <span className="feature-emoji">\u{1F9EE}</span>
                <span>Calculate math</span>
              </div>
              <div className="feature-card">
                <span className="feature-emoji">\u{1F550}</span>
                <span>Check the time</span>
              </div>
            </div>
          </div>
        )}

        {thread?.messages.map((msg) => (
          <div key={msg.id}>
            <MessageBubble message={msg} />
            {msg.toolCalls && msg.toolCalls.length > 0 && (
              <ToolCallDisplay toolCalls={msg.toolCalls} />
            )}
          </div>
        ))}

        {isStreaming && (
          <div>
            {streamingToolCalls.length > 0 && (
              <ToolCallDisplay toolCalls={streamingToolCalls} isStreaming />
            )}
            {streamingContent && (
              <MessageBubble
                message={{
                  id: "streaming",
                  role: "assistant",
                  content: streamingContent,
                  createdAt: new Date().toISOString(),
                }}
                isStreaming
              />
            )}
            {!streamingContent && streamingToolCalls.length === 0 && (
              <div className="message assistant">
                <div className="message-avatar">\u{1F916}</div>
                <div className="message-content">
                  <div className="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="input-container">
        <div className="input-wrapper">
          <textarea
            ref={inputRef}
            className="message-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message..."
            rows={1}
            disabled={isStreaming}
          />
          {isStreaming ? (
            <button
              className="send-btn stop"
              onClick={stopStreaming}
              title="Stop"
            >
              \u23F9
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim()}
              title="Send"
            >
              \u2191
            </button>
          )}
        </div>
        <p className="input-hint">
          Press Enter to send, Shift+Enter for new line
        </p>
      </div>
    </main>
  );
}
