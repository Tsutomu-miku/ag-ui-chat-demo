/**
 * ag-ui-react — AG-UI protocol React hooks and state management.
 *
 * Provides reusable hooks and pure state reducers for building
 * AG-UI-powered chat interfaces with React.
 *
 * @packageDocumentation
 */

// ── Types ──
export type {
  ToolCallFunction,
  ChatMessage,
  TraceEvent,
  ChatThread,
  ThreadSummary,
  FrontendToolDefinition,
  PendingToolCall,
  ActiveStep,
  ThreadAgentEvent,
  AgUiTraceEvent,
} from "./types.js";
export {
  AG_UI_TRACE_EVENT_NAME,
  AG_UI_TRACE_PROTOCOL_VERSION,
} from "./types.js";

// ── Pure state reducer ──
export { updateMessagesWithAgentEvent } from "./reducer.js";

// ── Hooks ──
export { useAgentChat } from "./hooks.js";
export type { UseAgentChatOptions, UseAgentChatReturn } from "./hooks.js";

export { useThreads } from "./threads.js";
export type { UseThreadsOptions, UseThreadsReturn } from "./threads.js";
