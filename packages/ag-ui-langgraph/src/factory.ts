import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { createReactAgent as createLangGraphReactAgent } from "@langchain/langgraph/prebuilt";

import { LangGraphAgent } from "./agent.js";

/** Configuration for createReactAgent factory (convenience). */
export interface ReactAgentConfig {
  /** Display name for this agent */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools (server-side execution) */
  tools?: any[];
  /** System prompt */
  systemPrompt?: string;
}

/** Sub-agent definition for supervisor-shaped factory configs. */
export interface SubAgentDefinition {
  /** System prompt for the sub-agent */
  systemPrompt: string;
  /** Tools available to the sub-agent */
  tools: any[];
  /** Optional: override model for this sub-agent */
  model?: BaseChatModel;
}

/** Configuration for createSupervisor compatibility helper. */
export interface SupervisorConfig {
  /** Display name */
  name?: string;
  /** The LangChain chat model */
  model: BaseChatModel;
  /** Backend tools the supervisor can call directly */
  tools?: any[];
  /** System prompt */
  systemPrompt?: string;
  /** Sub-agent definitions keyed by name */
  subAgents: Record<string, SubAgentDefinition>;
}

/**
 * Build LangGraph's prebuilt React agent and wrap it in the AG-UI adapter.
 */
export function createReactAgent(config: ReactAgentConfig): LangGraphAgent {
  const graph = createLangGraphReactAgent({
    llm: config.model,
    tools: config.tools ?? [],
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });

  return new LangGraphAgent({
    name: config.name ?? "agent",
    graph,
  });
}

/**
 * Compatibility helper for supervisor-shaped configs.
 *
 * This does not construct a true multi-agent supervisor topology. Build that
 * graph explicitly and pass it to `new LangGraphAgent({ graph })` when needed.
 */
export function createSupervisor(config: SupervisorConfig): LangGraphAgent {
  const graph = createLangGraphReactAgent({
    llm: config.model,
    tools: config.tools ?? [],
    ...(config.systemPrompt ? { prompt: config.systemPrompt } : {}),
  });

  return new LangGraphAgent({
    name: config.name ?? "supervisor",
    graph,
  });
}
