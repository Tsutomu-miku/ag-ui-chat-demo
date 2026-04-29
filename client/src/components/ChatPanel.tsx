import { useState, useRef, useEffect, useCallback } from "react";
import {
  useAgentChat,
  type ActiveStep,
  type ChatMessage,
  type ChatThread,
  type ThreadAgentEvent,
} from "ag-ui-react";
import { MessageBubble } from "./MessageBubble";
import { FrontendToolUI } from "./FrontendToolUI";
import { ExecutionTree } from "./ExecutionTree";
import {
  buildTurnPresentation,
  filterTraceEventsForTurn,
  getMessageSourceLabel,
} from "./trace";
import { FRONTEND_TOOLS } from "../tools/frontendTools";

type DemoMode = "agent" | "protocol";

function buildMessageView(messages: ChatMessage[]) {
  return {
    hasMessages: messages.length > 0,
    hasStreamingMessage: messages.some((message) => message.isStreaming),
    hasActiveToolCall: messages.some((message) =>
      message.toolCalls?.some((toolCall) => !toolCall.complete),
    ),
  };
}

function buildConversationTurns(messages: ChatMessage[]) {
  const turns: Array<{
    id: string;
    user?: ChatMessage;
    events: ChatMessage[];
  }> = [];

  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ id: message.id, user: message, events: [] });
      continue;
    }

    const currentTurn = turns[turns.length - 1];
    if (currentTurn) {
      currentTurn.events.push(message);
    } else {
      turns.push({ id: message.id, events: [message] });
    }
  }

  return turns;
}

interface ChatPanelProps {
  thread: ChatThread | null;
  threadActions: {
    ensureActiveThread: (threadId?: string | null) => Promise<string>;
    refreshList: () => Promise<void>;
    appendMessage: (msg: ChatThread["messages"][0]) => void;
    appendToolResult: (
      threadId: string,
      toolCallId: string,
      result: string,
    ) => void;
    handleThreadEvent: (threadId: string, event: ThreadAgentEvent) => void;
    activeSteps: ActiveStep[];
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
  const [demoMode, setDemoMode] = useState<DemoMode>("agent");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    sendMessage,
    stopStreaming,
    resolveToolCall,
    isStreaming,
    pendingToolCalls,
  } = useAgentChat({
    agentUrl: demoMode === "protocol" ? "/api/protocol-demo" : "/api/agent",
    frontendTools: FRONTEND_TOOLS,
    onThreadEvent: threadActions.handleThreadEvent,
  });
  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [thread?.messages, pendingToolCalls, threadActions.activeSteps]);

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

    const threadId = await threadActions.ensureActiveThread(thread?.id);

    const userMsg = {
      id: crypto.randomUUID(),
      role: "user" as const,
      content: text,
      createdAt: new Date().toISOString(),
    };

    setInput("");

    threadActions.appendMessage(userMsg);

    await sendMessage(
      threadId,
      [userMsg],
      async () => {
        await threadActions.refreshList();
      },
      {
        forwardedProps: {
          streamSubgraphs: true,
        },
      },
    );
  }, [demoMode, input, isStreaming, thread, threadActions, sendMessage]);

  const handleToolResult = useCallback(
    async (toolCallId: string, result: string) => {
      if (!thread?.id) return;

      threadActions.appendToolResult(thread.id, toolCallId, result);

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

  const selectPrompt = (mode: DemoMode, prompt: string) => {
    setDemoMode(mode);
    setInput(prompt);
  };

  const messages = thread?.messages ?? [];
  const traceEvents = thread?.traceEvents ?? [];
  const { hasMessages, hasStreamingMessage, hasActiveToolCall } =
    buildMessageView(messages);
  const conversationTurns = buildConversationTurns(messages);

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
        <div className="mode-switch" aria-label="Demo mode">
          <button
            className={demoMode === "agent" ? "active" : ""}
            onClick={() => setDemoMode("agent")}
            type="button"
          >
            Agent
          </button>
          <button
            className={demoMode === "protocol" ? "active" : ""}
            onClick={() => setDemoMode("protocol")}
            type="button"
          >
            Protocol Lab
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {!hasMessages && !isStreaming && (
          <div className="welcome-screen">
            <div className="welcome-icon">AG</div>
            <h2>AG-UI LangGraph Demo</h2>
            <p>
              Run the LangGraph supervisor with researcher and writer
              sub-agents, or switch to a deterministic protocol lab when no LLM
              key is set.
            </p>
            <div className="protocol-strip">
              <span>supervisor</span>
              <span>handoff tools</span>
              <span>text stream</span>
              <span>state snapshot</span>
              <span>frontend resume</span>
            </div>
            <div className="feature-grid">
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt("protocol", "Run the AG-UI protocol lab")
                }
              >
                <span className="feature-emoji">⌁</span>
                <span>
                  Protocol Lab
                  <br />
                  <small>No LLM key required</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt("protocol", "Run the sub-agent tree demo")
                }
              >
                <span className="feature-emoji">🌲</span>
                <span>
                  Sub-agent Tree
                  <br />
                  <small>Deterministic handoff</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt(
                    "agent",
                    "Ask the researcher for the weather in Tokyo, then ask the writer for a concise travel note.",
                  )
                }
              >
                <span className="feature-emoji">🌤</span>
                <span>
                  Research + write
                  <br />
                  <small>Supervisor handoff</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt(
                    "agent",
                    "Research practical use cases for AG-UI agents, then write a short implementation brief with bullets.",
                  )
                }
              >
                <span className="feature-emoji">📝</span>
                <span>
                  Briefing chain
                  <br />
                  <small>Researcher to writer</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt(
                    "agent",
                    "Ask the writer to calculate (23 * 45) + (67 / 3), then explain the result in one paragraph.",
                  )
                }
              >
                <span className="feature-emoji">🧮</span>
                <span>
                  Math + Writing
                  <br />
                  <small>Writer agent</small>
                </span>
              </div>
              <div
                className="feature-card"
                onClick={() =>
                  selectPrompt(
                    "agent",
                    "Prepare a short deployment note, but confirm with me before treating the production deploy as approved.",
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
              <strong>Agent</strong> uses the configured LLM.{" "}
              <strong>Protocol Lab</strong> emits deterministic LangGraph-style
              events through the same adapter.
            </p>
          </div>
        )}

        {conversationTurns.map((turn, index) => {
          const isLatestTurn = index === conversationTurns.length - 1;
          const turnActiveSteps = isLatestTurn ? threadActions.activeSteps : [];
          const turnTraceEvents = filterTraceEventsForTurn(
            traceEvents,
            turn.events,
            isLatestTurn,
          );
          const presentation = buildTurnPresentation(
            turn.events,
            turnActiveSteps,
            turnTraceEvents,
          );
          const shouldShowTree = presentation.traceMode !== "none";

          return (
            <div key={turn.id}>
              {turn.user && (
                <MessageBubble
                  message={turn.user}
                  isStreaming={turn.user.isStreaming}
                />
              )}
              {shouldShowTree && presentation.traceMode !== "none" && (
                <ExecutionTree
                  messages={turn.events}
                  activeSteps={turnActiveSteps}
                  traceEvents={turnTraceEvents}
                  mode={presentation.traceMode}
                />
              )}
              {presentation.standaloneMessages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  isStreaming={message.isStreaming}
                  sourceLabel={getMessageSourceLabel(message)}
                />
              ))}
            </div>
          );
        })}

        {isStreaming &&
          !hasStreamingMessage &&
          !hasActiveToolCall &&
          threadActions.activeSteps.length === 0 && (
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
          Enter to send · Shift+Enter for new line ·{" "}
          {demoMode === "protocol"
            ? "Protocol Lab streams deterministic AG-UI events"
            : "Agent mode uses the configured LangGraph assistant"}
        </p>
      </div>
    </main>
  );
}
