import type { ActiveStep, AgentEventRecord, ChatMessage } from "ag-ui-react";

import {
  AgentTraceView,
  buildToolResultMap,
  TimelineTraceView,
  type TraceMode,
} from "./trace";

interface Props {
  messages: ChatMessage[];
  activeSteps: ActiveStep[];
  events: AgentEventRecord[];
  mode: Exclude<TraceMode, "none">;
}
export function ExecutionTree({ messages, activeSteps, events, mode }: Props) {
  const toolResultById = buildToolResultMap(messages);
  const hasTraceContent =
    messages.some(
      (message) =>
        (message.toolCalls?.length ?? 0) > 0 || message.role === "tool",
    ) || activeSteps.length > 0 || events.length > 0;

  if (!hasTraceContent) return null;

  return (
    <section className="execution-tree" aria-label="Run activity">
      <div className="execution-tree-title">
        <span>{mode === "agent" ? "Agent activity" : "Execution activity"}</span>
        {activeSteps.length > 0 && <span className="trace-live">Live</span>}
      </div>
      {mode === "agent" ? (
        <AgentTraceView
          messages={messages}
          activeSteps={activeSteps}
          events={events}
          toolResultById={toolResultById}
        />
      ) : (
        <TimelineTraceView
          messages={messages}
          activeSteps={activeSteps}
          toolResultById={toolResultById}
        />
      )}
    </section>
  );
}
