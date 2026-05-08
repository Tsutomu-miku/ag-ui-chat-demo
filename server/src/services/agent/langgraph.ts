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
import { HumanMessage, ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import {
  Command,
  END,
  getCurrentTaskInput,
  MessagesAnnotation,
  Send,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { createReactAgent as createLangGraphReactAgent } from "@langchain/langgraph/prebuilt";
import { LangGraphAgent } from "ag-ui-langgraph";
import type { LocalCompiledGraph } from "ag-ui-langgraph";
import { v4 as uuid } from "uuid";
import { z } from "zod";

import { frontendInteractionTools } from "./tools.js";
import {
  researcherTools,
  TRAVEL_GUIDANCE_RESEARCHER_SYSTEM_PROMPT,
  WEATHER_RESEARCHER_SYSTEM_PROMPT,
} from "./subagents/researcher.js";
import { writerTools, WRITER_SYSTEM_PROMPT } from "./subagents/writer.js";
import { createAgentModel } from "./model.js";
import { createDemoVisualizationExtension } from "./visualization-extension.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentTaskMessages() {
  const state = getCurrentTaskInput();
  if (!isRecord(state) || !Array.isArray(state.messages)) return [];
  return state.messages;
}

function buildHandoffToolMessage(name: string, toolCallId?: string) {
  return new ToolMessage({
    content: "Successfully transferred control",
    name,
    tool_call_id: toolCallId ?? uuid(),
  });
}

function buildReturnToSupervisorMessage(
  sourceNode: string,
  findings: string,
  toolCallId?: string,
) {
  return new ToolMessage({
    content: `Return from ${sourceNode}:\n${findings}`,
    name: "transfer_back_to_supervisor",
    tool_call_id: toolCallId ?? uuid(),
  });
}

function createSingleAgentHandoffTool(
  name: string,
  targetNode: "weather_researcher" | "travel_guidance_researcher" | "writer",
  description: string,
): StructuredToolInterface {
  return tool(
    async (
      input: {
        input: string;
      },
      config,
    ) =>
      new Command({
        graph: Command.PARENT,
        goto: [
          new Send(targetNode, {
            messages: [new HumanMessage(input.input)],
          }),
        ],
        update: {
          messages: [
            ...currentTaskMessages(),
            buildHandoffToolMessage(name, config?.toolCall?.id),
          ],
        },
      }),
    {
      name,
      description,
      schema: z.object({
        input: z.string().min(1).describe("The exact task for the sub-agent."),
      }),
    },
  );
}

function createParallelResearchTool(): StructuredToolInterface {
  return tool(
    async (
      input: {
        weatherTask: string;
        travelGuidanceTask: string;
      },
      config,
    ) =>
      new Command({
        graph: Command.PARENT,
        goto: [
          new Send("weather_researcher", {
            messages: [new HumanMessage(input.weatherTask)],
          }),
          new Send("travel_guidance_researcher", {
            messages: [new HumanMessage(input.travelGuidanceTask)],
          }),
        ],
        update: {
          messages: [
            ...currentTaskMessages(),
            buildHandoffToolMessage(
              "start_parallel_research",
              config?.toolCall?.id,
            ),
          ],
        },
      }),
    {
      name: "start_parallel_research",
      description:
        "Launch the weather researcher and travel-guidance researcher in parallel with two distinct explicit tasks.",
      schema: z.object({
        weatherTask: z
          .string()
          .min(1)
          .describe("The exact task for the weather researcher."),
        travelGuidanceTask: z
          .string()
          .min(1)
          .describe("The exact task for the travel-guidance researcher."),
      }),
    },
  );
}

function createReturnToSupervisorTool(
  sourceNode: "weather_researcher" | "travel_guidance_researcher" | "writer",
): StructuredToolInterface {
  return tool(
    async (
      input: {
        input: string;
      },
      config,
    ) =>
      new Command({
        graph: Command.PARENT,
        goto: "supervisor",
        update: {
          messages: [
            ...currentTaskMessages(),
            buildReturnToSupervisorMessage(
              sourceNode,
              input.input,
              config?.toolCall?.id,
            ),
          ],
        },
      }),
    {
      name: "transfer_back_to_supervisor",
      description:
        "Return control to the supervisor with the exact completed findings or draft in the input field.",
      schema: z.object({
        input: z
          .string()
          .min(1)
          .describe("The exact findings, guidance, or draft to hand back."),
      }),
    },
  );
}

function getAgent(): LangGraphAgent {
  if (_agent) return _agent;

  const model = createAgentModel();
  const startParallelResearch = createParallelResearchTool();
  const transferToWeatherResearcher = createSingleAgentHandoffTool(
    "transfer_to_weather_researcher",
    "weather_researcher",
    "Transfer control to the weather researcher with an explicit weather-focused task.",
  );
  const transferToTravelGuidanceResearcher = createSingleAgentHandoffTool(
    "transfer_to_travel_guidance_researcher",
    "travel_guidance_researcher",
    "Transfer control to the travel-guidance researcher with an explicit guidance-focused task.",
  );
  const transferToWriter = createSingleAgentHandoffTool(
    "transfer_to_writer",
    "writer",
    "Transfer control to the writer with the exact brief to turn into the final note.",
  );
  const returnFromWeatherResearcher =
    createReturnToSupervisorTool("weather_researcher");
  const returnFromTravelGuidanceResearcher = createReturnToSupervisorTool(
    "travel_guidance_researcher",
  );
  const returnFromWriter = createReturnToSupervisorTool("writer");
  const weatherResearcher = createLangGraphReactAgent({
    llm: model,
    tools: [...researcherTools, returnFromWeatherResearcher],
    name: "weather_researcher",
    prompt: `${WEATHER_RESEARCHER_SYSTEM_PROMPT}

Completion rule:
- When you have completed the assigned weather research, you MUST call transfer_back_to_supervisor.
- Put the actual findings you want the supervisor to use into the tool argument "input".
- Do not answer the end user directly and do not stop without calling transfer_back_to_supervisor.`,
  });
  const supervisor = createLangGraphReactAgent({
    llm: model,
    tools: [
      ...frontendInteractionTools,
      startParallelResearch,
      transferToWeatherResearcher,
      transferToTravelGuidanceResearcher,
      transferToWriter,
    ],
    name: "supervisor",
    prompt: `${SUPERVISOR_SYSTEM_PROMPT}

Coordination rule:
- You are the only agent allowed to communicate the final answer to the user.
- Before delegating, give a short coordination update in your own voice.
- After any sub-agent returns, read the returned findings, then decide the next step yourself.
- After the writer returns, produce the final answer yourself instead of delegating again.
- Treat transfer_back_to_supervisor results as worker outputs for your decision-making.`,
  });
  const travelGuidanceResearcher = createLangGraphReactAgent({
    llm: model,
    tools: [...researcherTools, returnFromTravelGuidanceResearcher],
    name: "travel_guidance_researcher",
    prompt: `${TRAVEL_GUIDANCE_RESEARCHER_SYSTEM_PROMPT}

Additional constraint:
- Do NOT call get_weather yourself
- Focus on destination-specific activity, clothing, and packing guidance using the user request and general travel research

Completion rule:
- When you have completed the assigned guidance task, you MUST call transfer_back_to_supervisor.
- Put the actual guidance you want the supervisor to use into the tool argument "input".
- Do not answer the end user directly and do not stop without calling transfer_back_to_supervisor.`,
  });
  const writer = createLangGraphReactAgent({
    llm: model,
    tools: [...writerTools, returnFromWriter],
    name: "writer",
    prompt: `${WRITER_SYSTEM_PROMPT}

Completion rule:
- When you finish the requested draft, you MUST call transfer_back_to_supervisor.
- Put the exact final draft into the tool argument "input".
- Do not present yourself as the final speaker to the user and do not stop without calling transfer_back_to_supervisor.`,
  });

  const graph = new StateGraph(MessagesAnnotation)
    .addNode("supervisor", supervisor, {
      ends: ["weather_researcher", "travel_guidance_researcher", "writer", END],
    })
    .addNode("weather_researcher", weatherResearcher, {
      ends: ["supervisor"],
    })
    .addNode("travel_guidance_researcher", travelGuidanceResearcher, {
      ends: ["supervisor"],
    })
    .addNode("writer", writer, {
      ends: ["supervisor"],
    })
    .addEdge(START, "supervisor")
    .compile({
      name: "supervisor",
    }) as LocalCompiledGraph;

  _agent = new LangGraphAgent({
    name: "supervisor",
    graph,
    eventExtensions: [createDemoVisualizationExtension()],
  });

  return _agent;
}

// ── Endpoint handler ──

export async function* runLangGraphAgent(
  input: RunAgentInput,
  _signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  // clone() per request for isolated state (aligned with Python pattern)
  yield* getAgent().clone().run(input);
}
