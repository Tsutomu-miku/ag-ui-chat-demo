import type { ChatMessage } from "ag-ui-react";

import { TraceMarkdown } from "./trace/TraceMarkdown";

interface Props {
  message: ChatMessage;
  isStreaming?: boolean;
  sourceLabel?: string;
}

export function MessageBubble({ message, isStreaming, sourceLabel }: Props) {
  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "👤" : "🤖"}</div>
      <div className="message-content">
        {sourceLabel && (
          <div className="message-source">
            <span className="message-source-badge">{sourceLabel}</span>
          </div>
        )}
        <TraceMarkdown
          content={message.content}
          isStreaming={isStreaming}
          className="message-markdown"
        />
      </div>
    </div>
  );
}
