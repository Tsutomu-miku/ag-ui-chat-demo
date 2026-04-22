import React from "react";

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface ToolCallDisplayProps {
  toolCalls: ToolCall[];
  isStreaming?: boolean;
}

export function ToolCallDisplay({
  toolCalls,
  isStreaming,
}: ToolCallDisplayProps) {
  return (
    <div className="tool-calls">
      {toolCalls.map((tc) => (
        <div
          key={tc.id}
          className={`tool-call ${isStreaming ? "streaming" : ""}`}
        >
          <div className="tool-call-header">
            <span className="tool-icon">\u{1F527}</span>
            <span className="tool-name">{tc.name}</span>
            {isStreaming && <span className="tool-spinner">\u23F3</span>}
          </div>
          {tc.args && (
            <pre className="tool-args">{tryFormatJSON(tc.args)}</pre>
          )}
        </div>
      ))}
    </div>
  );
}

function tryFormatJSON(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2);
  } catch {
    return str;
  }
}
