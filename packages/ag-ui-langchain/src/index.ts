/**
 * ag-ui-langchain — AG-UI protocol adapter for LangChain / LangGraph.
 *
 * TypeScript implementation aligned with Python ag_ui_langgraph (v0.0.34).
 *
 * @packageDocumentation
 */

// ── Types ──
export type {
  StreamEventMetadata,
  LangChainToolCall,
  LangGraphReasoning,
  LangGraphEventTypes,
  CustomEventNames,
  State,
  SchemaKeys,
  ThinkingProcess,
  MessageInProgress,
  RunMetadata,
  MessagesInProgressRecord,
  ToolCall,
  BaseLangGraphPlatformMessage,
  LangGraphPlatformResultMessage,
  LangGraphPlatformActionExecutionMessage,
  LangGraphPlatformMessage,
  PredictStateTool,
} from "./types.js";

export {
  LangGraphEventTypes as LangGraphEventTypesEnum,
  CustomEventNames as CustomEventNamesEnum,
} from "./types.js";

// ── Message conversion (aligned with Python utils.py) ──
export {
  // AG-UI ↔ LangChain message conversion
  toLangChainMessages,
  aguiMessagesToLangchain,
  langchainMessagesToAgui,

  // Multimodal conversion
  convertLangchainMultimodalToAgui,
  convertAguiMultimodalToLangchain,

  // Content helpers
  contentToString,
  parseToolArgs,
  stringifyIfNeeded,
  resolveMessageContent,
  flattenUserContent,
  normalizeToolContent,

  // Reasoning resolution
  resolveReasoningContent,
  resolveEncryptedReasoningContent,

  // Tool / model helpers
  frontendToolToModelTool,
  getToolCalls,
  asArray,

  // JSON-safe serialization
  makeJsonSafe,
  jsonSafeStringify,
  camelToSnake,

  // Schema key helpers
  filterObjectBySchemaKeys,
  getStreamPayloadInput,
} from "./convert.js";

export type { AGUIContentItem } from "./convert.js";

// ── Streaming (AI message stream → AG-UI events) ──
export {
  eventsFromAIMessageStream,
  withStreamEventMetadata,
} from "./stream.js";

// ── Tool event helpers ──
export { eventsFromToolMessage, toAIMessage } from "./tools.js";

// ── Agent loop factories ──
export {
  createAgentLoop,
  createSupervisorLoop,
} from "./loop.js";

export type { AgentLoopConfig, SupervisorLoopConfig } from "./loop.js";
