import { useState } from "react";
import type { PendingToolCall } from "../types";

interface Props {
  pendingToolCalls: PendingToolCall[];
  onResolve: (toolCallId: string, result: string) => void;
}

export function FrontendToolUI({ pendingToolCalls, onResolve }: Props) {
  return (
    <div className="frontend-tool-ui">
      {pendingToolCalls.map((tc) => (
        <div key={tc.toolCallId} className="frontend-tool-card">
          {tc.toolCallName === "confirm_action" && (
            <ConfirmActionUI toolCall={tc} onResolve={onResolve} />
          )}
          {tc.toolCallName === "collect_user_input" && (
            <CollectInputUI toolCall={tc} onResolve={onResolve} />
          )}
        </div>
      ))}
    </div>
  );
}

// ============================================================
// confirm_action: Show a confirmation dialog
// ============================================================

function ConfirmActionUI({
  toolCall,
  onResolve,
}: {
  toolCall: PendingToolCall;
  onResolve: (id: string, result: string) => void;
}) {
  const action = toolCall.args.action as string | undefined;
  const severity = (toolCall.args.severity as string) ?? "medium";

  return (
    <div className={`confirm-dialog severity-${severity}`}>
      <div className="confirm-header">
        <span className="confirm-icon">
          {severity === "high" ? "⚠️" : severity === "medium" ? "❓" : "ℹ️"}
        </span>
        <h4>Action Confirmation Required</h4>
      </div>
      <p className="confirm-action">{action}</p>
      {severity === "high" && (
        <p className="confirm-warning">This is a high-severity action. Please review carefully.</p>
      )}
      <div className="confirm-buttons">
        <button
          className="btn btn-danger"
          onClick={() =>
            onResolve(
              toolCall.toolCallId,
              JSON.stringify({ approved: false, reason: "User rejected the action" })
            )
          }
        >
          Reject
        </button>
        <button
          className="btn btn-primary"
          onClick={() =>
            onResolve(
              toolCall.toolCallId,
              JSON.stringify({ approved: true })
            )
          }
        >
          Approve
        </button>
      </div>
    </div>
  );
}

// ============================================================
// collect_user_input: Show an input form
// ============================================================

function CollectInputUI({
  toolCall,
  onResolve,
}: {
  toolCall: PendingToolCall;
  onResolve: (id: string, result: string) => void;
}) {
  const [value, setValue] = useState("");
  const prompt = toolCall.args.prompt as string | undefined;
  const placeholder = toolCall.args.placeholder as string | undefined;

  return (
    <div className="input-dialog">
      <div className="input-dialog-header">
        <span className="input-icon">📝</span>
        <h4>Information Needed</h4>
      </div>
      <p className="input-prompt">{prompt}</p>
      <textarea
        className="input-field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder || "Type your response..."}
        rows={3}
      />
      <div className="input-buttons">
        <button
          className="btn btn-ghost"
          onClick={() =>
            onResolve(toolCall.toolCallId, JSON.stringify({ skipped: true }))
          }
        >
          Skip
        </button>
        <button
          className="btn btn-primary"
          disabled={!value.trim()}
          onClick={() =>
            onResolve(
              toolCall.toolCallId,
              JSON.stringify({ input: value.trim() })
            )
          }
        >
          Submit
        </button>
      </div>
    </div>
  );
}
