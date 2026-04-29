import type { ActiveStep, ChatMessage } from "ag-ui-react";

import {
  buildTimelineTraceEntries,
  getToolInputDisplay,
  getToolResultDisplay,
  getToolInfo,
  isDelegationTool,
} from "./model";

interface Props {
  messages: ChatMessage[];
  activeSteps: ActiveStep[];
  toolResultById: Map<
    string,
    {
      content: string;
      isStreaming: boolean;
    }
  >;
}

export function TimelineTraceView({
  messages,
  activeSteps,
  toolResultById,
}: Props) {
  const entries = buildTimelineTraceEntries(messages);

  if (entries.length === 0 && activeSteps.length === 0) {
    return null;
  }

  return (
    <div className="trace-timeline">
      {entries.map(({ messageId, toolCall }) => {
        const info = getToolInfo(toolCall.function.name);
        const output = toolResultById.get(toolCall.id);
        const inputDisplay = getToolInputDisplay(toolCall);
        const outputDisplay = output ? getToolResultDisplay(output) : undefined;

        return (
          <div className={`trace-tool ${info.type}`} key={`${messageId}-${toolCall.id}`}>
            <div className="trace-tool-header">
              <span className="trace-tool-mark" />
              <span className="trace-tool-name">{info.label}</span>
              <span
                className={`trace-tool-state ${toolCall.complete ? "done" : "running"}`}
              >
                {toolCall.complete ? "Complete" : "Running"}
              </span>
            </div>

            {inputDisplay && !isDelegationTool(toolCall.function.name) && (
              <div className="trace-io">
                <span>{inputDisplay.isStreaming ? "Input streaming" : "Input"}</span>
                <pre>
                  {inputDisplay.content}
                  {inputDisplay.isStreaming && (
                    <span className="cursor-blink">▊</span>
                  )}
                </pre>
              </div>
            )}

            {outputDisplay && !isDelegationTool(toolCall.function.name) && (
              <div className="trace-io">
                <span>{outputDisplay.isStreaming ? "Output streaming" : "Output"}</span>
                <pre>
                  {outputDisplay.content}
                  {outputDisplay.isStreaming && (
                    <span className="cursor-blink">▊</span>
                  )}
                </pre>
              </div>
            )}
          </div>
        );
      })}

      {entries.length === 0 && activeSteps.length > 0 && (
        <div className="trace-empty">
          <span className="trace-dot" />
          Receiving events
        </div>
      )}
    </div>
  );
}
