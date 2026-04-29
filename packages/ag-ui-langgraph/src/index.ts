/**
 * ag-ui-langgraph — AG-UI protocol adapter for LangGraph.
 *
 * TypeScript implementation fully aligned with Python ag_ui_langgraph (v0.0.34).
 *
 * ## Architecture (aligned with Python)
 *
 * The core `LangGraphAgent` accepts a **compiled LangGraph state graph** and
 * translates its internal execution events (`graph.streamEvents(version: "v2")`)
 * into AG-UI protocol events. This is the same pattern as the Python package.
 *
 * Factory functions `createReactAgent` / `createSupervisor` build LangGraph
 * graphs under the hood, then wrap them in `LangGraphAgent`.
 *
 * ## Quick Start
 *
 * ```ts
 * import { LangGraphAgent, createReactAgent } from "ag-ui-langgraph";
 * import { createAgentEndpoint } from "ag-ui-hono";
 *
 * // Option 1: Direct graph wrapping (most aligned with Python)
 * import { createReactAgent as lgCreateReactAgent } from "@langchain/langgraph/prebuilt";
 * const graph = lgCreateReactAgent({ llm: model, tools });
 * const agent = new LangGraphAgent({ name: "my-agent", graph });
 *
 * // Option 2: Factory helper
 * const agent = createReactAgent({ model, tools, systemPrompt: "..." });
 *
 * // Wire into endpoint
 * const app = createAgentEndpoint((input) => agent.clone().run(input));
 * ```
 *
 * @packageDocumentation
 */

// ── Agent class and factories (primary API, aligned with Python) ──
export {
  LangGraphAgent,
} from "./agent.js";

export {
  createReactAgent,
  createSupervisor,
} from "./factory.js";
export { createProtocolTracePlugin } from "./plugins/trace.js";

export type {
  LangGraphAgentConfig,
} from "./agent.js";

export type {
  ReactAgentConfig,
  SubAgentDefinition,
  SupervisorConfig,
  SupervisorOutputMode,
} from "./factory.js";
export type {
  LangGraphPlugin,
  LangGraphPluginContext,
} from "./plugins/trace.js";

// ── Types (aligned with Python types.py) ──
export type {
  StreamEventMetadata,
  LangChainToolCall,
  LangGraphReasoning,
  State,
  SchemaKeys,
  ThinkingProcess,
  MessageInProgress,
  RunMetadata,
  MessagesInProgressRecord,
  ToolCall,
  JsonPrimitive,
  JsonValue,
  JsonObject,
  RunnableConfigLike,
  LocalCompiledGraph,
  BaseLangGraphPlatformMessage,
  LangGraphPlatformResultMessage,
  LangGraphPlatformActionExecutionMessage,
  LangGraphPlatformMessage,
  PredictStateTool,
  PreparedStream,
  ForwardedProps,
  LangGraphStreamEvent,
  ToolCallChunk,
  InterruptLike,
  CheckpointTaskLike,
  CheckpointSnapshotLike,
  GraphWithCheckpointing,
  TraceStepKind,
} from "./types.js";

export {
  LangGraphEventTypes,
  CustomEventNames,
  DEFAULT_SCHEMA_KEYS,
} from "./types.js";

export {
  AG_UI_TRACE_EVENT_NAME,
  AG_UI_TRACE_PROTOCOL_VERSION,
  createTraceCustomEvent,
} from "./trace.js";

export type {
  AgUiTraceCustomEvent,
  AgUiTraceCustomValue,
  AgUiTraceEvent,
  AgUiTraceSource,
} from "./trace.js";

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
} from "./utils/convert.js";

export type { AGUIContentItem } from "./utils/convert.js";
