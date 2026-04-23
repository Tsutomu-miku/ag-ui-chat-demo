/**
 * ag-ui-langchain — AG-UI protocol adapter for LangChain / LangGraph.
 *
 * TypeScript implementation aligned with Python ag_ui_langgraph (v0.0.34).
 *
 * ## Quick Start
 *
 * ```ts
 * import { createReactAgent, createSupervisor } from "ag-ui-langchain";
 * import { createAgentEndpoint } from "ag-ui-hono";
 *
 * // Single agent
 * const agent = createReactAgent({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   tools: [searchWeb, calculate],
 *   systemPrompt: "You are a helpful assistant.",
 * });
 *
 * // Multi-agent supervisor
 * const supervisor = createSupervisor({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   subAgents: {
 *     researcher: { systemPrompt: "...", tools: [searchWeb] },
 *     writer:     { systemPrompt: "...", tools: [calculate] },
 *   },
 * });
 *
 * // Wire into endpoint (one line)
 * const app = createAgentEndpoint((input, signal) => agent.clone().run(input, signal));
 * ```
 *
 * @packageDocumentation
 */

// ── Agent classes and factories (primary API) ──
export {
  LangGraphAgent,
  SupervisorAgent,
  createReactAgent,
  createSupervisor,
} from "./agent.js";

export type {
  LangGraphAgentConfig,
  SupervisorConfig,
} from "./agent.js";

// Re-export SubAgentDefinition (defined in loop.ts, re-exported via agent.ts)
export type { SubAgentDefinition } from "./loop.js";

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
  toLangChainMessages,
  aguiMessagesToLangchain,
  langchainMessagesToAgui,
  convertLangchainMultimodalToAgui,
  convertAguiMultimodalToLangchain,
  contentToString,
  parseToolArgs,
  stringifyIfNeeded,
  resolveMessageContent,
  flattenUserContent,
  normalizeToolContent,
  resolveReasoningContent,
  resolveEncryptedReasoningContent,
  frontendToolToModelTool,
  getToolCalls,
  asArray,
  makeJsonSafe,
  jsonSafeStringify,
  camelToSnake,
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

// ── Low-level loop functions (use LangGraphAgent / createReactAgent instead) ──
export {
  createAgentLoop,
  createSupervisorLoop,
} from "./loop.js";

export type { AgentLoopConfig, SupervisorLoopConfig } from "./loop.js";
