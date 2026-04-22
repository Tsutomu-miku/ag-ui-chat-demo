import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage } from "../types";

interface Props {
  message: ChatMessage;
  isStreaming?: boolean;
}

export function MessageBubble({ message, isStreaming }: Props) {
  return (
    <div className={`message ${message.role}`}>
      <div className="message-avatar">{message.role === "user" ? "👤" : "🤖"}</div>
      <div className="message-content">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
        {isStreaming && <span className="cursor-blink">▊</span>}
      </div>
    </div>
  );
}
