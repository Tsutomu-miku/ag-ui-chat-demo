/**
 * LangGraph Agent — refactored to use ag-ui-langchain package.
 *
 * The core streaming, conversion, and tool utilities are now imported
 * from the reusable package. This file contains only the demo-specific
 * agent configuration (supervisor prompt, sub-agent wiring).
 */

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { v4 as uuid } from "uuid";

import { createLogger } from "../../config/logger.js";
import {
  // Re-export stream utilities from package
  eventsFromAIMessageStream,
  withStreamEventMetadata,
  eventsFromToolMessage,
  toAIMessage,
  // Conversion utilities
  asArray,
  contentToString,
  frontendToolToModelTool,
  getToolCalls,
  toLangChainMessages,
  // Types
  type StreamEventMetadata,
} from "ag-ui-langchain";
import { backendTools } from "./tools.js";
import {
  researcherTools,
  RESEARCHER_SYSTEM_PROMPT,
} from "./subagents/researcher.js";
import { writerTools, WRITER_SYSTEM_PROMPT } from "./subagents/writer.js";
import { createAgentModel } from "./model.js";

const logger = createLogger("langgraph");

// Re-export for backward compatibility with existing tests
export { eventsFromAIMessageStream, eventsFromToolMessage, toAIMessage };

// ============================================================
// Sub-agent runner
// ============================================================

/** Known sub-agent names the supervisor can delegate to. */
const SUB_AGENT_NAMES = new Set(["researcher", "writer"]);

interface SubAgentConfig {
  systemPrompt: string;
  tools: Parameters<ReturnType<typeof createAgentModel>["bindTools"]>[0];
}

const SUB_AGENT_CONFIGS: Record<string, SubAgentConfig> = {
  researcher: {
    systemPrompt: RESEARCHER_SYSTEM_PROMPT,
    tools: researcherTools,
  },
  writer: {
    systemPrompt: WRITER_SYSTEM_PROMPT,
    tools: writerTools,
  },
};

/**
 * Run a sub-agent loop.
 * Yields AG-UI events wrapped in STEP_STARTED / STEP_FINISHED.
 * Returns the accumulated text output for the caller to feed back into context.
 */
async function* runSubAgent(
  agentName: string,
  parentMessages: BaseMessage[],
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent, string> {
  const config = SUB_AGENT_CONFIGS[agentName];
  if (!config) return "";

  const metadata: StreamEventMetadata = {
    stepName: agentName,
    parentStepName: "supervisor",
  };

  yield withStreamEventMetadata(
    { type: EventType.STEP_STARTED, stepName: agentName } as BaseEvent,
    metadata,
  );

  logger.info("sub-agent started", { agentName });

  const model = createAgentModel().bindTools(config.tools);
  const toolNode = new ToolNode(config.tools as never[]);

  // Sub-agent gets parent conversation + its own system prompt
  const subMessages: BaseMessage[] = [
    new SystemMessage(config.systemPrompt),
    ...parentMessages,
  ];

  let textOutput = "";

  while (!signal?.aborted) {
    const stream = await model.stream(subMessages, { signal });
    const finalChunk = yield* eventsFromAIMessageStream(stream, metadata);

    if (!finalChunk) break;

    const finalMessage = toAIMessage(finalChunk);
    subMessages.push(finalMessage);

    // Capture text content for returning to caller
    const text = contentToString(finalMessage.content);
    if (text) textOutput += text;

    const toolCalls = getToolCalls(finalMessage);
    if (toolCalls.length === 0) break;

    const toolResult = await toolNode.invoke({ messages: subMessages });
    for (const message of asArray(toolResult.messages)) {
      subMessages.push(message);
      if (message instanceof ToolMessage) {
        yield* eventsFromToolMessage(message, metadata);
      }
    }
  }

  logger.info("sub-agent finished", { agentName });

  yield withStreamEventMetadata(
    { type: EventType.STEP_FINISHED, stepName: agentName } as BaseEvent,
    metadata,
  );

  return textOutput;
}

// ============================================================
// Supervisor prompt
// ============================================================

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

// ============================================================
// Main agent runner (Supervisor mode)
// ============================================================

export async function* runLangGraphAgent(
  input: RunAgentInput,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const messages = toLangChainMessages(input.messages);
  const frontendTools = input.tools || [];
  const frontendToolNames = new Set(frontendTools.map((tool) => tool.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);

  // The "delegate" meta-tool the supervisor uses to invoke sub-agents
  const delegateTool = {
    type: "function" as const,
    function: {
      name: "delegate_to_subagent",
      description:
        "Delegate the current task to a specialised sub-agent. The sub-agent will see the full conversation history and use its own tools to fulfil the request.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            enum: [...SUB_AGENT_NAMES],
            description: "Which sub-agent to delegate to",
          },
          instruction: {
            type: "string",
            description:
              "Optional extra instruction for the sub-agent (appended to conversation)",
          },
        },
        required: ["agent"],
      },
    },
  };

  const supervisorModel = createAgentModel().bindTools([
    ...backendTools,
    ...frontendModelTools,
    delegateTool,
  ]);
  const backendToolNode = new ToolNode(backendTools);
  const stateMessages: BaseMessage[] = [
    new SystemMessage(SUPERVISOR_SYSTEM_PROMPT),
    ...messages,
  ];

  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent;

  logger.debug("supervisor run started", {
    threadId: input.threadId,
    messageCount: messages.length,
    backendToolCount: backendTools.length,
    frontendToolCount: frontendTools.length,
  });

  // ── Supervisor STEP wraps the entire run (single start/finish) ──
  const supervisorMetadata: StreamEventMetadata = { stepName: "supervisor" };

  yield withStreamEventMetadata(
    {
      type: EventType.STEP_STARTED,
      stepName: "supervisor",
    } as BaseEvent,
    supervisorMetadata,
  );

  // Accumulate sub-agent results so later sub-agents can see earlier ones
  const subAgentResults: { agent: string; output: string }[] = [];

  // Supervisor loop — max iterations to prevent runaway
  const MAX_SUPERVISOR_ITERATIONS = 10;

  for (let i = 0; i < MAX_SUPERVISOR_ITERATIONS && !signal?.aborted; i++) {
    const aiResponseStream = await supervisorModel.stream(stateMessages, {
      signal,
    });
    const finalChunk = yield* eventsFromAIMessageStream(
      aiResponseStream,
      supervisorMetadata,
    );

    if (!finalChunk) break;

    const finalMessage = toAIMessage(finalChunk);
    stateMessages.push(finalMessage);

    const toolCalls = getToolCalls(finalMessage);
    if (toolCalls.length === 0) break;

    // Check for frontend tool calls → break to let frontend handle
    if (toolCalls.some((tc) => frontendToolNames.has(tc.name))) {
      break;
    }

    // Separate delegation calls from regular tool calls
    const delegateCalls = toolCalls.filter(
      (tc) => tc.name === "delegate_to_subagent",
    );
    const regularCalls = toolCalls.filter(
      (tc) => tc.name !== "delegate_to_subagent",
    );

    // Handle all delegation calls
    for (const delegateCall of delegateCalls) {
      const agentName = String(delegateCall.args?.agent || "");
      const instruction = delegateCall.args?.instruction
        ? String(delegateCall.args.instruction)
        : undefined;

      if (!SUB_AGENT_NAMES.has(agentName)) {
        // Unknown agent — feed error back to supervisor
        const errorMessage = new ToolMessage({
          content: `Error: Unknown sub-agent "${agentName}". Available agents: ${[...SUB_AGENT_NAMES].join(", ")}`,
          tool_call_id: delegateCall.id || uuid(),
        });
        stateMessages.push(errorMessage);
        yield* eventsFromToolMessage(errorMessage, supervisorMetadata);
        continue;
      }

      // Acknowledge the delegation tool call
      const delegateResultMessage = new ToolMessage({
        content: `Delegating to ${agentName}...`,
        tool_call_id: delegateCall.id || uuid(),
      });
      stateMessages.push(delegateResultMessage);

      // Build context for the sub-agent:
      // user messages + previous sub-agent results + optional instruction
      const subAgentContext: BaseMessage[] = [...messages];

      // Inject previous sub-agent results so later agents can see earlier outputs
      for (const prev of subAgentResults) {
        subAgentContext.push(
          new AIMessage({
            id: uuid(),
            content: `[${prev.agent} sub-agent result]:\n${prev.output}`,
          }),
        );
      }

      if (instruction) {
        subAgentContext.push(
          new SystemMessage(
            `Additional instruction from supervisor: ${instruction}`,
          ),
        );
      }

      // Run sub-agent and yield its events; capture text output via return value
      const subAgentGen = runSubAgent(agentName, subAgentContext, signal);
      let subAgentOutput = "";
      let genResult = await subAgentGen.next();

      while (!genResult.done) {
        yield genResult.value;
        genResult = await subAgentGen.next();
      }

      // genResult.value is the return value (textOutput) from the generator
      subAgentOutput = genResult.value || "";

      // Store result for future sub-agents
      if (subAgentOutput) {
        subAgentResults.push({ agent: agentName, output: subAgentOutput });

        // Feed sub-agent result back to supervisor
        stateMessages.push(
          new AIMessage({
            id: uuid(),
            content: `[${agentName} sub-agent result]:\n${subAgentOutput}`,
          }),
        );
      }
    }

    // Handle regular backend tool calls (if any alongside delegation)
    if (regularCalls.length > 0) {
      const toolResult = await backendToolNode.invoke({
        messages: stateMessages,
      });
      for (const message of asArray(toolResult.messages)) {
        stateMessages.push(message);
        if (message instanceof ToolMessage) {
          yield* eventsFromToolMessage(message, supervisorMetadata);
        }
      }
    }

    // If we processed delegations, continue supervisor loop for next decision
    if (delegateCalls.length > 0) {
      continue;
    }
  }

  // ── Close supervisor STEP at end of run ──
  yield withStreamEventMetadata(
    {
      type: EventType.STEP_FINISHED,
      stepName: "supervisor",
    } as BaseEvent,
    supervisorMetadata,
  );

  if (!signal?.aborted) {
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent;
  }
}
