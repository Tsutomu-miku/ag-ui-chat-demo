/**
 * LangGraph Agent — Demo configuration using ag-ui-langchain.
 *
 * This file shows how simple it is to set up an agent using the
 * `LangGraphAgent` class, which wraps a compiled LangGraph graph
 * and translates its execution events into AG-UI protocol events —
 * aligned with the Python ag_ui_langgraph pattern.
 */

import type { BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";
import { LangGraphAgent } from "ag-ui-langchain";
import { createReactAgent as lgCreateReactAgent } from "@langchain/langgraph/prebuilt";

import { backendTools } from "./tools.js";
import {
  researcherTools,
  RESEARCHER_SYSTEM_PROMPT,
} from "./subagents/researcher.js";
import { writerTools, WRITER_SYSTEM_PROMPT } from "./subagents/writer.js";
import { createAgentModel } from "./model.js";

// ── Agent definition ──

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

// Lazy singleton — avoids module-load-time env errors
let _agent: LangGraphAgent | null = null;

function getAgent(): LangGraphAgent {
  if (!_agent) {
    // Build a real LangGraph compiled graph using the prebuilt react agent
    const model = createAgentModel();
    const allTools = [...backendTools, ...researcherTools, ...writerTools];

    const graph = lgCreateReactAgent({
      llm: model,
      tools: allTools,
      prompt: SUPERVISOR_SYSTEM_PROMPT,
    });

    // Wrap in LangGraphAgent — aligned with Python pattern:
    // Python: agent = LangGraphAgent(graph=graph, name="supervisor")
    _agent = new LangGraphAgent({
      name: "supervisor",
      graph,
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
  yield* getAgent().clone().run(input);
}
