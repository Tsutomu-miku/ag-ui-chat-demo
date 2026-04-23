/**
 * LangGraph Agent — Demo configuration using ag-ui-langchain.
 *
 * This file shows how simple it is to set up a multi-agent supervisor
 * using the `createSupervisor` factory. The entire wiring (delegation tool,
 * sub-agent lifecycle, context sharing, step events) is handled by the package.
 */

import type { BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";
import {
  createSupervisor,
  type SupervisorAgent,
  // Re-export low-level utilities for backward-compat with existing tests
  eventsFromAIMessageStream,
  eventsFromToolMessage,
  toAIMessage,
} from "ag-ui-langchain";

import { backendTools } from "./tools.js";
import {
  researcherTools,
  RESEARCHER_SYSTEM_PROMPT,
} from "./subagents/researcher.js";
import { writerTools, WRITER_SYSTEM_PROMPT } from "./subagents/writer.js";
import { createAgentModel } from "./model.js";

// Re-export for backward compatibility with existing tests
export { eventsFromAIMessageStream, eventsFromToolMessage, toAIMessage };

// ── Agent definition (lazy singleton to avoid module-load-time env errors) ──

const SUPERVISOR_SYSTEM_PROMPT = `You are a Supervisor agent that coordinates specialized sub-agents to answer the user's request.

Available sub-agents (call them via the "delegate_to_subagent" tool):
- **researcher**: Searches the web, checks weather, gets current time. Use for any information-gathering task.
- **writer**: Composes well-structured text, can do calculations. Use for writing, summarising, or formatting tasks.

Your workflow:
1. Analyse the user's request.
2. If the request needs research (facts, weather, news, time), delegate to "researcher".
3. If the request needs polished writing or calculation, delegate to "writer".
4. For complex tasks, delegate to "researcher" first, then "writer" to synthesise.
5. For simple greetings or trivial chat, respond directly WITHOUT delegating.
6. After a sub-agent finishes, review the conversation and either delegate to another sub-agent, use backend/frontend tools directly, or respond to the user.

IMPORTANT: Issue only ONE delegate_to_subagent call per turn. Do NOT combine delegation with other tool calls in the same response.

You also have direct access to all backend and frontend tools. Use them directly for simple, single-step tasks instead of delegating.`;

let _agent: SupervisorAgent | null = null;

function getAgent(): SupervisorAgent {
  if (!_agent) {
    _agent = createSupervisor({
      name: "supervisor",
      model: createAgentModel(),
      tools: backendTools,
      systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
      subAgents: {
        researcher: {
          systemPrompt: RESEARCHER_SYSTEM_PROMPT,
          tools: researcherTools,
        },
        writer: {
          systemPrompt: WRITER_SYSTEM_PROMPT,
          tools: writerTools,
        },
      },
    });
  }
  return _agent;
}

// ── Endpoint handler ──

export async function* runLangGraphAgent(
  input: RunAgentInput,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  // clone() per request for isolated state (aligned with Python pattern)
  yield* getAgent().clone().run(input, signal);
}
