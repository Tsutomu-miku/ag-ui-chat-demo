/**
 * LangGraphAgent — High-level AG-UI adapter for LangChain / LangGraph.
 *
 * Aligned with Python `ag_ui_langgraph.LangGraphAgent`:
 * - Construct with a compiled graph (or use `createReactAgent` / `createSupervisor` helpers)
 * - Call `agent.run(input)` to get an AsyncGenerator of AG-UI events
 * - Call `agent.clone()` per request to isolate per-request state
 *
 * @example Simple single-agent
 * ```ts
 * import { createReactAgent } from "ag-ui-langchain";
 *
 * const agent = createReactAgent({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   tools: [searchWeb, calculate],
 *   systemPrompt: "You are a helpful assistant.",
 * });
 *
 * // In your endpoint handler:
 * const events = agent.clone().run(input, signal);
 * ```
 *
 * @example Multi-agent supervisor
 * ```ts
 * import { createSupervisor } from "ag-ui-langchain";
 *
 * const agent = createSupervisor({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   subAgents: {
 *     researcher: { systemPrompt: "...", tools: [searchWeb] },
 *     writer:     { systemPrompt: "...", tools: [calculate] },
 *   },
 * });
 *
 * // Same usage:
 * const events = agent.clone().run(input, signal);
 * ```
 *
 * @packageDocumentation
 */

import type { BaseEvent, RunAgentInput } from "@ag-ui/core";

import {
  createAgentLoop,
  createSupervisorLoop,
  type AgentLoopConfig,
  type SupervisorLoopConfig,
} from "./loop.js";

// ── Type aliases (primary API surface) ──
// These are re-exports with friendlier names for class consumers.

/** Configuration for `LangGraphAgent` / `createReactAgent`. */
export type LangGraphAgentConfig = AgentLoopConfig;

/** Configuration for a sub-agent within a supervisor. */
export type { SubAgentDefinition } from "./loop.js";

/** Configuration for `SupervisorAgent` / `createSupervisor`. */
export type SupervisorConfig = SupervisorLoopConfig;

// ── LangGraphAgent class ──

/**
 * Core AG-UI agent adapter, aligned with Python `LangGraphAgent`.
 *
 * Call `clone()` per request to get isolated per-request state,
 * then `run(input)` to stream AG-UI events.
 */
export class LangGraphAgent {
  readonly name: string;
  protected readonly config: LangGraphAgentConfig;

  constructor(config: LangGraphAgentConfig) {
    this.name = config.name ?? "agent";
    this.config = config;
  }

  /** Create a fresh copy with clean per-request state (aligned with Python `clone()`). */
  clone(): LangGraphAgent {
    return new (this.constructor as new (c: LangGraphAgentConfig) => LangGraphAgent)(this.config);
  }

  /** Run the agent, yielding AG-UI events (aligned with Python `run()`). */
  async *run(input: RunAgentInput, signal?: AbortSignal): AsyncGenerator<BaseEvent> {
    yield* createAgentLoop(input, this.config, signal);
  }
}

// ── SupervisorAgent class ──

/**
 * Multi-agent supervisor variant. Automatically sets up delegation
 * tool and sub-agent coordination — the consumer only needs to declare
 * sub-agents with their prompts and tools.
 */
export class SupervisorAgent extends LangGraphAgent {
  protected readonly supervisorConfig: SupervisorConfig;

  constructor(config: SupervisorConfig) {
    super(config);
    this.supervisorConfig = config;
  }

  clone(): SupervisorAgent {
    return new SupervisorAgent(this.supervisorConfig);
  }

  async *run(input: RunAgentInput, signal?: AbortSignal): AsyncGenerator<BaseEvent> {
    yield* createSupervisorLoop(input, this.supervisorConfig, signal);
  }
}

// ── Factory functions (the recommended API) ──

/**
 * Create a single-agent that streams AG-UI events.
 *
 * This is the simplest entry point — pass a model and tools, get an agent.
 *
 * ```ts
 * const agent = createReactAgent({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   tools: [searchWeb, calculate],
 *   systemPrompt: "You are a helpful assistant.",
 * });
 * ```
 */
export function createReactAgent(config: LangGraphAgentConfig): LangGraphAgent {
  return new LangGraphAgent(config);
}

/**
 * Create a supervisor agent that coordinates sub-agents.
 *
 * The supervisor automatically gets a `delegate_to_subagent` tool and
 * handles all the sub-agent lifecycle (step events, context sharing,
 * tool execution, error handling).
 *
 * ```ts
 * const agent = createSupervisor({
 *   model: new ChatOpenAI({ model: "gpt-4o" }),
 *   subAgents: {
 *     researcher: { systemPrompt: "...", tools: [searchWeb] },
 *     writer:     { systemPrompt: "...", tools: [calculate] },
 *   },
 * });
 * ```
 */
export function createSupervisor(config: SupervisorConfig): SupervisorAgent {
  return new SupervisorAgent(config);
}
