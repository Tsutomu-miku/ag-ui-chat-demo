import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createReactAgent as createLangGraphReactAgent } from "@langchain/langgraph/prebuilt";
import { createSupervisor as createLangGraphSupervisor } from "@langchain/langgraph-supervisor";

import { LangGraphAgent } from "./agent.js";
import type { LocalCompiledGraph } from "./types.js";
import type { LangGraphPlugin } from "./plugins/trace.js";

/** Configuration for createReactAgent factory (convenience). */
export interface ReactAgentConfig {
  /** Display name for this agent */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools (server-side execution) */
  tools?: StructuredToolInterface[];
  /** System prompt */
  systemPrompt?: string;
  /** Optional protocol plugins */
  plugins?: LangGraphPlugin[];
}

/** Sub-agent definition for supervisor-shaped factory configs. */
export interface SubAgentDefinition {
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /** Tools available to the sub-agent */
  tools: StructuredToolInterface[];
  /** Optional: override model for this sub-agent */
  model?: BaseChatModel;
}

export type SupervisorOutputMode = "full_history" | "last_message";

/** Configuration for createSupervisor compatibility helper. */
export interface SupervisorConfig {
  /** Display name */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools the supervisor can call directly */
  tools?: StructuredToolInterface[];
  /** System prompt */
  systemPrompt?: string;
  /** Sub-agent definitions keyed by name */
  subAgents: Record<string, SubAgentDefinition>;
  /** How much sub-agent history to preserve in the supervisor conversation */
  outputMode?: SupervisorOutputMode;
  /** Optional protocol plugins */
  plugins?: LangGraphPlugin[];
}

/**
 * Build LangGraph's prebuilt React agent and wrap it in the AG-UI adapter.
 */
export function createReactAgent(config: ReactAgentConfig): LangGraphAgent {
  const graph = createLangGraphReactAgent({
    llm: config.model,
    tools: config.tools ?? [],
    ...(config.name ? { name: config.name } : {}),
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  }) as LocalCompiledGraph;

  return new LangGraphAgent({
    name: config.name ?? "agent",
    graph,
    plugins: config.plugins,
  });
}

/**
 * Build a real LangGraph supervisor topology and wrap it in the AG-UI adapter.
 */
export function createSupervisor(config: SupervisorConfig): LangGraphAgent {
  const supervisorName = config.name ?? "supervisor";
  const agents = Object.entries(config.subAgents).map(([agentName, subAgent]) =>
    createLangGraphReactAgent({
      llm: subAgent.model ?? config.model,
      tools: subAgent.tools,
      name: agentName,
      prompt: subAgent.systemPrompt,
    }),
  );

  const workflow = createLangGraphSupervisor({
    agents,
    llm: config.model,
    tools: config.tools ?? [],
    supervisorName,
    outputMode: config.outputMode ?? "full_history",
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });
  const graph = workflow.compile({ name: supervisorName }) as LocalCompiledGraph;

  return new LangGraphAgent({
    name: supervisorName,
    graph,
    plugins: config.plugins,
    subAgents: Object.keys(config.subAgents),
  });
}
