import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../hooks/useThreads";

interface MessageBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: MessageBubbleProps) {
  const isUser = message.role === "user";

  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">{isUser ? "\u{1F464}" : "\u{1F916}"}</div>
      <div className="message-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>
          {message.content}
        </ReactMarkdown>
        {isStreaming && <span className="cursor-blink">\u258A</span>}
      </div>
    </div>
  );
}
