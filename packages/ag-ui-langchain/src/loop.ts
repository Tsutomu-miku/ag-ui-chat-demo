/**
 * AG-UI agent loop factories.
 *
 * Provides `createAgentLoop` and `createSupervisorLoop` — generic,
 * reusable agent execution loops that convert LangChain model + tools
 * into AG-UI event streams.
 *
 * These are higher-level than the raw stream converters in stream.ts
 * and tools.ts, providing ready-made patterns for common agent architectures.
 */

import { EventType, type BaseEvent, type RunAgentInput, type Tool } from "@ag-ui/core";
import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { v4 as uuid } from "uuid";

import {
  asArray,
  contentToString,
  frontendToolToModelTool,
  getToolCalls,
  toLangChainMessages,
} from "./convert.js";
import { eventsFromAIMessageStream, withStreamEventMetadata } from "./stream.js";
import { eventsFromToolMessage, toAIMessage } from "./tools.js";
import type { LangChainToolCall, StreamEventMetadata } from "./types.js";

type BindToolsFn = NonNullable<BaseChatModel["bindTools"]>;
type ModelToolDefinitions = Parameters<BindToolsFn>[0];

function bindModelTools(model: BaseChatModel, tools: ModelToolDefinitions) {
  const bindTools = model.bindTools;
  if (!bindTools) {
    throw new Error("Configured chat model does not support tool binding.");
  }
  return bindTools.call(model, tools);
}

// ============================================================
// Agent loop configuration
// ============================================================

export interface AgentLoopConfig {
  /** The LangChain chat model to use (must support bindTools) */
  model: BaseChatModel;
  /** Backend tools the agent can call server-side */
  tools?: ModelToolDefinitions;
  /** System prompt prepended to messages */
  systemPrompt?: string;
  /** Maximum iterations before stopping (default: 10) */
  maxIterations?: number;
}

export interface SupervisorLoopConfig extends AgentLoopConfig {
  /** Sub-agent definitions keyed by name */
  subAgents: Record<
    string,
    {
      /** System prompt for the sub-agent */
      systemPrompt: string;
      /** Tools available to the sub-agent */
      tools: ModelToolDefinitions;
      /** Optional: custom model for this sub-agent */
      model?: BaseChatModel;
    }
  >;
}

// ============================================================
// createAgentLoop — single-agent execution
// ============================================================

/**
 * Create a single-agent loop that streams AG-UI events.
 *
 * This is the simplest agent pattern: one model with tools, running
 * in a loop until it produces a text response (no more tool calls).
 *
 * @returns An async generator yielding AG-UI BaseEvent objects
 */
export async function* createAgentLoop(
  input: RunAgentInput,
  config: AgentLoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const {
    model,
    tools = [],
    systemPrompt,
    maxIterations = 10,
  } = config;

  const messages = toLangChainMessages(input.messages);
  const frontendTools: Tool[] = input.tools || [];
  const frontendToolNames = new Set(frontendTools.map((t) => t.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);

  const boundModel = bindModelTools(model, [
    ...(tools as ModelToolDefinitions),
    ...frontendModelTools,
  ]);

  const toolNode =
    (tools as unknown[]).length > 0 ? new ToolNode(tools as never[]) : null;

  const stateMessages: BaseMessage[] = [];
  if (systemPrompt) {
    stateMessages.push(new SystemMessage(systemPrompt));
  }
  stateMessages.push(...messages);

  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent;

  for (let i = 0; i < maxIterations && !signal?.aborted; i++) {
    const aiStream = await boundModel.stream(stateMessages, { signal });
    const finalChunk = yield* eventsFromAIMessageStream(aiStream);

    if (!finalChunk) break;

    const finalMessage = toAIMessage(finalChunk);
    stateMessages.push(finalMessage);

    const toolCalls = getToolCalls(finalMessage);
    if (toolCalls.length === 0) break;

    // Frontend tool calls → break to let the client handle them
    if (toolCalls.some((tc) => frontendToolNames.has(tc.name))) break;

    // Execute backend tool calls
    if (toolNode) {
      const toolResult = await toolNode.invoke({ messages: stateMessages });
      for (const message of asArray(toolResult.messages)) {
        stateMessages.push(message);
        if (message instanceof ToolMessage) {
          yield* eventsFromToolMessage(message);
        }
      }
    }
  }

  if (!signal?.aborted) {
    yield {
      type: EventType.RUN_FINISHED,
      threadId: input.threadId,
      runId: input.runId,
    } as BaseEvent;
  }
}

// ============================================================
// createSupervisorLoop — multi-agent supervisor pattern
// ============================================================

/**
 * Run a sub-agent loop (internal helper).
 * Yields AG-UI events wrapped with step metadata.
 * Returns the accumulated text output for context sharing.
 */
async function* runSubAgent(
  agentName: string,
  parentMessages: BaseMessage[],
  subConfig: SupervisorLoopConfig["subAgents"][string],
  baseModel: BaseChatModel,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent, string> {
  const metadata: StreamEventMetadata = {
    stepName: agentName,
    parentStepName: "supervisor",
  };

  yield withStreamEventMetadata(
    { type: EventType.STEP_STARTED, stepName: agentName } as BaseEvent,
    metadata,
  );

  const model = bindModelTools(subConfig.model ?? baseModel, subConfig.tools);
  const toolNode = new ToolNode(subConfig.tools as never[]);

  const subMessages: BaseMessage[] = [
    new SystemMessage(subConfig.systemPrompt),
    ...parentMessages,
  ];

  let textOutput = "";

  while (!signal?.aborted) {
    const stream = await model.stream(subMessages, { signal });
    const finalChunk = yield* eventsFromAIMessageStream(stream, metadata);

    if (!finalChunk) break;

    const finalMessage = toAIMessage(finalChunk);
    subMessages.push(finalMessage);

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

  yield withStreamEventMetadata(
    { type: EventType.STEP_FINISHED, stepName: agentName } as BaseEvent,
    metadata,
  );

  return textOutput;
}

/**
 * Create a supervisor loop that coordinates multiple sub-agents.
 *
 * The supervisor model can:
 * 1. Call backend tools directly
 * 2. Delegate to sub-agents via `delegate_to_subagent` meta-tool
 * 3. Emit frontend tool calls for the client to handle
 * 4. Respond with text to end the conversation turn
 *
 * Sub-agents receive the full conversation history plus any previous
 * sub-agent results for cross-agent context sharing.
 *
 * @returns An async generator yielding AG-UI BaseEvent objects
 */
export async function* createSupervisorLoop(
  input: RunAgentInput,
  config: SupervisorLoopConfig,
  signal?: AbortSignal,
): AsyncGenerator<BaseEvent> {
  const {
    model,
    tools = [],
    systemPrompt,
    maxIterations = 10,
    subAgents,
  } = config;

  const subAgentNames = new Set(Object.keys(subAgents));
  const messages = toLangChainMessages(input.messages);
  const frontendTools: Tool[] = input.tools || [];
  const frontendToolNames = new Set(frontendTools.map((t) => t.name));
  const frontendModelTools = frontendTools.map(frontendToolToModelTool);

  // The delegation meta-tool
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
            enum: [...subAgentNames],
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

  const supervisorModel = bindModelTools(model, [
    ...(tools as ModelToolDefinitions),
    ...frontendModelTools,
    delegateTool,
  ]);

  const backendToolNode =
    (tools as unknown[]).length > 0 ? new ToolNode(tools as never[]) : null;

  const stateMessages: BaseMessage[] = [];
  if (systemPrompt) {
    stateMessages.push(new SystemMessage(systemPrompt));
  }
  stateMessages.push(...messages);

  yield {
    type: EventType.RUN_STARTED,
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent;

  // Supervisor STEP wraps the entire run
  const supervisorMetadata: StreamEventMetadata = { stepName: "supervisor" };

  yield withStreamEventMetadata(
    { type: EventType.STEP_STARTED, stepName: "supervisor" } as BaseEvent,
    supervisorMetadata,
  );

  // Cross-sub-agent context sharing
  const subAgentResults: { agent: string; output: string }[] = [];

  for (let i = 0; i < maxIterations && !signal?.aborted; i++) {
    const aiStream = await supervisorModel.stream(stateMessages, { signal });
    const finalChunk = yield* eventsFromAIMessageStream(
      aiStream,
      supervisorMetadata,
    );

    if (!finalChunk) break;

    const finalMessage = toAIMessage(finalChunk);
    stateMessages.push(finalMessage);

    const toolCalls = getToolCalls(finalMessage);
    if (toolCalls.length === 0) break;

    // Frontend tool calls → break
    if (toolCalls.some((tc) => frontendToolNames.has(tc.name))) break;

    // Separate delegation from regular tool calls
    const delegateCalls = toolCalls.filter(
      (tc) => tc.name === "delegate_to_subagent",
    );
    const regularCalls = toolCalls.filter(
      (tc) => tc.name !== "delegate_to_subagent",
    );

    // Handle delegations
    for (const delegateCall of delegateCalls) {
      const agentName = String(delegateCall.args?.agent || "");
      const instruction = delegateCall.args?.instruction
        ? String(delegateCall.args.instruction)
        : undefined;

      if (!subAgentNames.has(agentName)) {
        // Unknown agent → error feedback
        const errorMessage = new ToolMessage({
          content: `Error: Unknown sub-agent "${agentName}". Available agents: ${[...subAgentNames].join(", ")}`,
          tool_call_id: delegateCall.id || uuid(),
        });
        stateMessages.push(errorMessage);
        yield* eventsFromToolMessage(errorMessage, supervisorMetadata);
        continue;
      }

      // Acknowledge delegation
      const delegateResult = new ToolMessage({
        content: `Delegating to ${agentName}...`,
        tool_call_id: delegateCall.id || uuid(),
      });
      stateMessages.push(delegateResult);

      // Build sub-agent context
      const subAgentContext: BaseMessage[] = [...messages];
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

      // Run sub-agent
      const subAgentConfig = subAgents[agentName];
      if (!subAgentConfig) {
        continue;
      }

      const subAgentGen = runSubAgent(
        agentName,
        subAgentContext,
        subAgentConfig,
        model,
        signal,
      );
      let subAgentOutput = "";
      let genResult = await subAgentGen.next();
      while (!genResult.done) {
        yield genResult.value;
        genResult = await subAgentGen.next();
      }
      subAgentOutput = genResult.value || "";

      if (subAgentOutput) {
        subAgentResults.push({ agent: agentName, output: subAgentOutput });
        stateMessages.push(
          new AIMessage({
            id: uuid(),
            content: `[${agentName} sub-agent result]:\n${subAgentOutput}`,
          }),
        );
      }
    }

    // Handle regular backend tool calls
    if (regularCalls.length > 0 && backendToolNode) {
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

    if (delegateCalls.length > 0) continue;
  }

  // Close supervisor STEP
  yield withStreamEventMetadata(
    { type: EventType.STEP_FINISHED, stepName: "supervisor" } as BaseEvent,
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
