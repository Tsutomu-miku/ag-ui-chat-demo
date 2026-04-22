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

// Map tool names to labels — includes sub-agent delegation
const TOOL_LABELS: Record<string, { icon: string; label: string; type: string }> = {
  get_weather: { icon: "🌤", label: "Weather Lookup", type: "backend" },
  search_web: { icon: "🔍", label: "Web Search", type: "backend" },
  calculate: { icon: "🧮", label: "Calculator", type: "backend" },
  get_current_time: { icon: "🕐", label: "Current Time", type: "backend" },
  confirm_action: { icon: "✅", label: "Confirm Action", type: "frontend" },
  collect_user_input: { icon: "📝", label: "User Input", type: "frontend" },
  delegate_to_subagent: { icon: "🤝", label: "Delegate to Sub-Agent", type: "delegation" },
};

export function ToolCallDisplay({ toolCalls, isStreaming }: Props) {
  return (
    <div className="tool-calls">
      {toolCalls.map((tc) => {
        const info = TOOL_LABELS[tc.name] || { icon: "🔧", label: tc.name, type: "unknown" };

        // For delegation calls, try to extract agent name from args
        let displayLabel = info.label;
        if (tc.name === "delegate_to_subagent" && tc.args) {
          try {
            const parsed = JSON.parse(tc.args);
            if (parsed.agent) {
              displayLabel = `Delegate → ${parsed.agent}`;
            }
          } catch {
            // use default label
          }
        }

        return (
          <div
            key={tc.id}
            className={`tool-call ${isStreaming && !tc.complete ? "streaming" : ""} ${info.type}`}
          >
            <div className="tool-call-header">
              <span className="tool-icon">{info.icon}</span>
              <span className="tool-name">{displayLabel}</span>
              <span className={`tool-type-badge ${info.type}`}>{info.type}</span>
              {isStreaming && !tc.complete && <span className="tool-spinner" />}
              {tc.complete && <span className="tool-check">✓</span>}
            </div>
            {tc.args && tc.name !== "delegate_to_subagent" && (
              <>
                <div className="tool-section-label">Input</div>
                <pre className="tool-args">{formatJSON(tc.args)}</pre>
              </>
            )}
            {tc.args && tc.name === "delegate_to_subagent" && (
              <>
                <div className="tool-section-label">Delegation</div>
                <pre className="tool-args">{formatJSON(tc.args)}</pre>
              </>
            )}
            {tc.result && tc.name !== "delegate_to_subagent" && (
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
