interface ToolCall {
  id: string;
  name: string;
  args: string;
  complete: boolean;
  result?: string;
}

interface Props {
  toolCalls: ToolCall[];
  isStreaming?: boolean;
}

// Map tool names to labels
const TOOL_LABELS: Record<string, { icon: string; label: string; type: string }> = {
  get_weather: { icon: "🌤", label: "Weather Lookup", type: "backend" },
  search_web: { icon: "🔍", label: "Web Search", type: "backend" },
  calculate: { icon: "🧮", label: "Calculator", type: "backend" },
  get_current_time: { icon: "🕐", label: "Current Time", type: "backend" },
  confirm_action: { icon: "✅", label: "Confirm Action", type: "frontend" },
  collect_user_input: { icon: "📝", label: "User Input", type: "frontend" },
};

export function ToolCallDisplay({ toolCalls, isStreaming }: Props) {
  return (
    <div className="tool-calls">
      {toolCalls.map((tc) => {
        const info = TOOL_LABELS[tc.name] || { icon: "🔧", label: tc.name, type: "unknown" };
        return (
          <div
            key={tc.id}
            className={`tool-call ${isStreaming && !tc.complete ? "streaming" : ""} ${info.type}`}
          >
            <div className="tool-call-header">
              <span className="tool-icon">{info.icon}</span>
              <span className="tool-name">{info.label}</span>
              <span className={`tool-type-badge ${info.type}`}>{info.type}</span>
              {isStreaming && !tc.complete && <span className="tool-spinner" />}
              {tc.complete && <span className="tool-check">✓</span>}
            </div>
            {tc.args && (
              <>
                <div className="tool-section-label">Input</div>
                <pre className="tool-args">{formatJSON(tc.args)}</pre>
              </>
            )}
            {tc.result && (
              <>
                <div className="tool-section-label">Output</div>
                <pre className="tool-args">{formatJSON(tc.result)}</pre>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function formatJSON(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
