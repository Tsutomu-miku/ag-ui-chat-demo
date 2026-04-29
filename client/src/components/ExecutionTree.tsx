import type { ActiveStep, ChatMessage, TraceEvent } from "ag-ui-react";

import {
  AgentTraceView,
  buildToolResultMap,
  TimelineTraceView,
  type TraceMode,
} from "./trace";

interface Props {
  messages: ChatMessage[];
  activeSteps: ActiveStep[];
  traceEvents: TraceEvent[];
  mode: Exclude<TraceMode, "none">;
}
export function ExecutionTree({ messages, activeSteps, traceEvents, mode }: Props) {
  const toolResultById = buildToolResultMap(messages);
  const hasTraceContent =
    messages.some(
      (message) =>
        (message.toolCalls?.length ?? 0) > 0 || message.role === "tool",
    ) || activeSteps.length > 0 || traceEvents.length > 0;

  if (!hasTraceContent) return null;

  return (
    <section className="execution-tree" aria-label="Run trace">
      <div className="execution-tree-title">
        <span>{mode === "agent" ? "Agent trace" : "Execution trace"}</span>
        {activeSteps.length > 0 && <span className="trace-live">Live</span>}
      </div>
      {mode === "agent" ? (
        <AgentTraceView
          messages={messages}
          activeSteps={activeSteps}
          traceEvents={traceEvents}
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
