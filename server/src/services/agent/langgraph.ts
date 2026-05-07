/**
 * LangGraph Agent — Demo configuration using ag-ui-langgraph.
 *
 * This file shows how simple it is to set up an agent using the
 * `LangGraphAgent` class, which wraps a compiled LangGraph graph
 * and translates its execution events into AG-UI protocol events —
 * aligned with the Python ag_ui_langgraph pattern.
 */

import type { BaseEvent } from "@ag-ui/core";
import type { RunAgentInput } from "@ag-ui/core";
import { createSupervisor, type LangGraphAgent } from "ag-ui-langgraph";

import { frontendInteractionTools } from "./tools.js";
import {
  researcherTools,
  TRAVEL_GUIDANCE_RESEARCHER_SYSTEM_PROMPT,
  WEATHER_RESEARCHER_SYSTEM_PROMPT,
} from "./subagents/researcher.js";
import { writerTools, WRITER_SYSTEM_PROMPT } from "./subagents/writer.js";
import { createAgentModel } from "./model.js";

// ── Agent definition ──

const SUPERVISOR_SYSTEM_PROMPT = `You are a Supervisor agent that coordinates specialized sub-agents to answer the user's request.

Available sub-agents:
- **weather_researcher**: Gathers current weather, forecast, humidity, precipitation, wind, and traveler-relevant conditions.
- **travel_guidance_researcher**: Gathers practical activity, packing, clothing, and itinerary guidance based on destination context.
- **writer**: Composes well-structured text, can do calculations. Use for writing, summarising, or formatting tasks.

Your workflow:
1. Analyse the user's request.
2. If the request needs factual weather or current-condition research, call transfer_to_weather_researcher.
3. If the request needs practical travel/activity/packing guidance, call transfer_to_travel_guidance_researcher.
4. If the request needs polished writing or calculation, call transfer_to_writer.
5. For complex tasks, first gather the needed evidence, then call transfer_to_writer to synthesise.
6. If the task needs both current conditions and practical guidance, you SHOULD call transfer_to_weather_researcher and transfer_to_travel_guidance_researcher in parallel in the same response.
7. After all research branches return, combine their findings into one concise brief and hand that brief to exactly one writer.
8. For simple greetings or trivial chat, respond directly WITHOUT delegating.
9. After a sub-agent finishes, review the conversation and either delegate to another sub-agent, ask for frontend confirmation/input, or respond to the user.
- Parallel research is preferred when the user asks for a richer output that naturally breaks into separate research tracks. Example: for a travel note, send one weather researcher to gather current conditions and one travel-guidance researcher to gather packing and activity guidance, then send the merged brief to one writer.
- When calling both researchers in parallel, each handoff must contain a different, explicit task. Do not send duplicate researcher tasks.
- After both researchers return, do not send more researchers unless a key gap remains. Prefer a single writer handoff after synthesis.

IMPORTANT: You may issue transfer_to_weather_researcher and transfer_to_travel_guidance_researcher in the same response when you are deliberately parallelising complementary research tasks. Do NOT combine research handoffs with transfer_to_writer in the same response.
When handing off, set the tool argument "input" to the exact task for that sub-agent. Do not leave it empty.
When handing off, ask that sub-agent only for work it can complete itself. Do not instruct a sub-agent to call transfer_to_weather_researcher, transfer_to_travel_guidance_researcher, transfer_to_writer, or any other handoff tool; all cross-agent routing must be done by you after the sub-agent returns.
Do NOT call writing tools such as write_text, compose_text, or summarize_text yourself. Those belong to the writer sub-agent only.
Avoid duplicate delegation. If a sub-agent already returned a usable result, either hand off to a different sub-agent or answer the user directly.
Prefer one final supervisor answer. Do not emit multiple near-identical summaries of the same completed work.

Use confirm_action before high-impact actions such as deployments, purchases, deletes, or sending messages. Use collect_user_input when a required detail is missing.`;

// Lazy singleton — avoids module-load-time env errors
let _agent: LangGraphAgent | null = null;

function getAgent(): LangGraphAgent {
  if (!_agent) {
    const model = createAgentModel();

    // Build a real LangGraph Supervisor topology and wrap the compiled graph.
    _agent = createSupervisor({
      name: "supervisor",
      model,
      tools: frontendInteractionTools,
      systemPrompt: SUPERVISOR_SYSTEM_PROMPT,
      outputMode: "full_history",
      subAgents: {
        weather_researcher: {
          systemPrompt: WEATHER_RESEARCHER_SYSTEM_PROMPT,
          tools: researcherTools,
        },
        travel_guidance_researcher: {
          systemPrompt: TRAVEL_GUIDANCE_RESEARCHER_SYSTEM_PROMPT,
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
  yield* getAgent().clone().run(input);
}
