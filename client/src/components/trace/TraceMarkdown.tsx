import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  content: string;
  isStreaming?: boolean;
  className: string;
}

export function TraceMarkdown({ content, isStreaming, className }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      {isStreaming && <span className="cursor-blink">▊</span>}
    </div>
  );
}
