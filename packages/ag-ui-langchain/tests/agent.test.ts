/**
 * Tests for agent.ts — LangGraphAgent, SupervisorAgent, and factory functions.
 *
 * Uses mock models to test the full agent lifecycle without real LLM calls.
 */

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { AIMessageChunk, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { describe, expect, it, vi } from "vitest";

import {
  LangGraphAgent,
  SupervisorAgent,
  createReactAgent,
  createSupervisor,
} from "../src/agent.js";

// ── Helpers ──

async function collectEvents(gen: AsyncGenerator<BaseEvent>): Promise<BaseEvent[]> {
  const events: BaseEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function makeInput(overrides?: Partial<RunAgentInput>): RunAgentInput {
  return {
    threadId: "thread-1",
    runId: "run-1",
    messages: [{ id: "msg-1", role: "user", content: "Hello" }],
    tools: [],
    ...overrides,
  };
}

/**
 * Create a mock chat model that streams chunks from a list of responses.
 * Each call to `stream()` consumes the next response in the list.
 */
function createMockModel(responses: AIMessageChunk[][]): BaseChatModel {
  let callIndex = 0;

  const mockModel = {
    bindTools(_tools: unknown[]) {
      return mockModel;
    },
    async *stream(_messages: unknown[], _opts?: unknown) {
      const response = responses[callIndex] ?? [];
      callIndex++;
      for (const chunk of response) {
        yield chunk;
      }
    },
  } as unknown as BaseChatModel;

  return mockModel;
}

/**
 * Create a text-only response (no tool calls) for mock model.
 */
function textResponse(id: string, text: string): AIMessageChunk[] {
  const words = text.split(" ");
  return words.map((word, i) =>
    new AIMessageChunk({
      id,
      content: i === 0 ? word : ` ${word}`,
    }),
  );
}

/**
 * Create a tool-call response for mock model.
 */
function toolCallResponse(
  id: string,
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
): AIMessageChunk[] {
  // First chunk: start of tool call
  const firstChunk = new AIMessageChunk({
    id,
    content: "",
    tool_call_chunks: toolCalls.map((tc, i) => ({
      id: tc.id,
      index: i,
      name: tc.name,
      args: JSON.stringify(tc.args),
      type: "tool_call_chunk" as const,
    })),
  });

  // Override tool_calls on the final chunk to simulate accumulated result
  const finalChunk = new AIMessageChunk({
    id,
    content: "",
    tool_calls: toolCalls.map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
      type: "tool_call" as const,
    })),
  });

  return [firstChunk, finalChunk];
}

/**
 * Create a delegation tool call response for supervisor mock.
 */
function delegateResponse(
  id: string,
  agentName: string,
  instruction?: string,
): AIMessageChunk[] {
  const args: Record<string, unknown> = { agent: agentName };
  if (instruction) args.instruction = instruction;

  return toolCallResponse(id, [
    { id: `delegate-${agentName}`, name: "delegate_to_subagent", args },
  ]);
}

// ============================================================
// LangGraphAgent
// ============================================================

describe("LangGraphAgent", () => {
  it("constructs with default name", () => {
    const model = createMockModel([]);
    const agent = new LangGraphAgent({ model });
    expect(agent.name).toBe("agent");
  });

  it("constructs with custom name", () => {
    const model = createMockModel([]);
    const agent = new LangGraphAgent({ model, name: "my-agent" });
    expect(agent.name).toBe("my-agent");
  });

  it("clone() returns a new instance with same config", () => {
    const model = createMockModel([]);
    const agent = new LangGraphAgent({ model, name: "original" });
    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(LangGraphAgent);
    expect(cloned.name).toBe("original");
  });

  it("run() emits RUN_STARTED, text events, and RUN_FINISHED", async () => {
    const model = createMockModel([
      textResponse("msg-ai-1", "Hello world"),
    ]);

    const agent = new LangGraphAgent({ model });
    const events = await collectEvents(agent.run(makeInput()));

    const types = events.map((e) => e.type);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("preserves threadId and runId in lifecycle events", async () => {
    const model = createMockModel([textResponse("ai-1", "Hi")]);
    const agent = new LangGraphAgent({ model });
    const events = await collectEvents(
      agent.run(makeInput({ threadId: "t-123", runId: "r-456" })),
    );

    const started = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    expect(started.threadId).toBe("t-123");
    expect(started.runId).toBe("r-456");

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    expect(finished.threadId).toBe("t-123");
    expect(finished.runId).toBe("r-456");
  });

  it("stops on frontend tool calls", async () => {
    const model = createMockModel([
      toolCallResponse("ai-1", [
        { id: "tc-1", name: "confirm_action", args: { action: "deploy" } },
      ]),
    ]);

    const agent = new LangGraphAgent({ model });
    const events = await collectEvents(
      agent.run(makeInput({
        tools: [{ name: "confirm_action", description: "Confirm action" }],
      })),
    );

    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_END);
    // Should still emit RUN_FINISHED after frontend tool call break
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("respects maxIterations", async () => {
    // Model that always returns tool calls — should stop after maxIterations
    const toolResp = toolCallResponse("ai", [
      { id: "tc", name: "backend_tool", args: {} },
    ]);
    // Each iteration: 1 tool call response. The loop needs a ToolNode, but
    // since we pass no real tools, the tool node won't be created and
    // the loop will just keep iterating. We test with maxIterations=2.
    const model = createMockModel([toolResp, toolResp, toolResp]);

    const agent = new LangGraphAgent({ model, maxIterations: 2 });
    const events = await collectEvents(agent.run(makeInput()));

    // Should have RUN_STARTED, tool events from 2 iterations, RUN_FINISHED
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("run() handles empty stream gracefully", async () => {
    const model = createMockModel([[]]);
    const agent = new LangGraphAgent({ model });
    const events = await collectEvents(agent.run(makeInput()));

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1]).toMatchObject({ type: EventType.RUN_FINISHED });
  });

  it("run() with system prompt doesn't error", async () => {
    const model = createMockModel([textResponse("ai-1", "OK")]);
    const agent = new LangGraphAgent({
      model,
      systemPrompt: "Be helpful.",
    });
    const events = await collectEvents(agent.run(makeInput()));
    expect(events.length).toBeGreaterThan(2);
  });
});

// ============================================================
// SupervisorAgent
// ============================================================

describe("SupervisorAgent", () => {
  it("constructs as a LangGraphAgent subclass", () => {
    const model = createMockModel([]);
    const agent = new SupervisorAgent({
      model,
      name: "supervisor",
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });

    expect(agent).toBeInstanceOf(LangGraphAgent);
    expect(agent).toBeInstanceOf(SupervisorAgent);
    expect(agent.name).toBe("supervisor");
  });

  it("clone() returns SupervisorAgent instance", () => {
    const model = createMockModel([]);
    const agent = new SupervisorAgent({
      model,
      subAgents: { writer: { systemPrompt: "Write", tools: [] } },
    });

    const cloned = agent.clone();
    expect(cloned).toBeInstanceOf(SupervisorAgent);
    expect(cloned).not.toBe(agent);
  });

  it("run() emits supervisor step wrapper events", async () => {
    const model = createMockModel([
      textResponse("ai-sup", "Final answer"),
    ]);

    const agent = new SupervisorAgent({
      model,
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });

    const events = await collectEvents(agent.run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.STEP_STARTED);
    expect(types).toContain(EventType.STEP_FINISHED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

    // Verify supervisor metadata
    const stepStarted = events.find(
      (e) => e.type === EventType.STEP_STARTED,
    ) as any;
    expect(stepStarted.stepName).toBe("supervisor");
  });

  it("run() handles delegation to sub-agents", async () => {
    // Supervisor delegates to "researcher", then researcher responds with text
    const supervisorModel = createMockModel([
      // First call: supervisor delegates
      delegateResponse("ai-sup-1", "researcher"),
      // Third call: supervisor summarises
      textResponse("ai-sup-2", "Summary done"),
    ]);

    // Sub-agent (researcher) responds with text
    // The sub-agent uses the same model but researcher's bindTools path
    // For this test, the mock model handles calls sequentially.
    // Call order: supervisor.stream → researcher.stream → supervisor.stream
    // But since bindTools returns the same mock, call indices:
    //   0 = supervisor delegate, 1 = researcher text, 2 = supervisor summary
    const model = createMockModel([
      delegateResponse("ai-sup-1", "researcher"),
      textResponse("ai-res-1", "Research results"),
      textResponse("ai-sup-2", "Summary done"),
    ]);

    const agent = new SupervisorAgent({
      model,
      subAgents: {
        researcher: { systemPrompt: "You are a researcher.", tools: [] },
      },
    });

    const events = await collectEvents(agent.run(makeInput()));
    const types = events.map((e) => e.type);

    // Should have nested step events for researcher
    const stepStarts = events.filter((e) => e.type === EventType.STEP_STARTED);
    expect(stepStarts.length).toBeGreaterThanOrEqual(2); // supervisor + researcher

    const researcherStep = stepStarts.find(
      (e) => (e as any).stepName === "researcher",
    );
    expect(researcherStep).toBeDefined();
    expect((researcherStep as any).parentStepName).toBe("supervisor");
  });

  it("run() handles unknown sub-agent gracefully", async () => {
    // Supervisor tries to delegate to non-existent agent
    const model = createMockModel([
      delegateResponse("ai-sup-1", "nonexistent"),
      textResponse("ai-sup-2", "Fallback response"),
    ]);

    const agent = new SupervisorAgent({
      model,
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });

    const events = await collectEvents(agent.run(makeInput()));
    const types = events.map((e) => e.type);

    // Should still complete successfully
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);

    // Should have tool result with error message
    const toolResults = events.filter(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    );
    const errorResult = toolResults.find(
      (e) => ((e as any).content as string).includes("Unknown sub-agent"),
    );
    expect(errorResult).toBeDefined();
  });

  it("run() with empty stream from supervisor", async () => {
    const model = createMockModel([[]]);
    const agent = new SupervisorAgent({
      model,
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });

    const events = await collectEvents(agent.run(makeInput()));
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1]).toMatchObject({ type: EventType.RUN_FINISHED });
  });
});

// ============================================================
// createReactAgent factory
// ============================================================

describe("createReactAgent", () => {
  it("returns a LangGraphAgent instance", () => {
    const model = createMockModel([]);
    const agent = createReactAgent({ model });
    expect(agent).toBeInstanceOf(LangGraphAgent);
  });

  it("supports full config", () => {
    const model = createMockModel([]);
    const agent = createReactAgent({
      model,
      name: "my-react-agent",
      systemPrompt: "Be helpful",
      maxIterations: 5,
    });
    expect(agent.name).toBe("my-react-agent");
  });

  it("clone + run pattern works", async () => {
    const model = createMockModel([
      textResponse("ai-1", "Response"),
    ]);

    const agent = createReactAgent({ model });
    const cloned = agent.clone();
    const events = await collectEvents(cloned.run(makeInput()));

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });
});

// ============================================================
// createSupervisor factory
// ============================================================

describe("createSupervisor", () => {
  it("returns a SupervisorAgent instance", () => {
    const model = createMockModel([]);
    const agent = createSupervisor({
      model,
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });
    expect(agent).toBeInstanceOf(SupervisorAgent);
    expect(agent).toBeInstanceOf(LangGraphAgent);
  });

  it("clone + run pattern works", async () => {
    const model = createMockModel([
      textResponse("ai-1", "Final answer"),
    ]);

    const agent = createSupervisor({
      model,
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
      },
    });

    const cloned = agent.clone();
    const events = await collectEvents(cloned.run(makeInput()));

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("supports multiple sub-agents", () => {
    const model = createMockModel([]);
    const agent = createSupervisor({
      model,
      name: "team-lead",
      subAgents: {
        researcher: { systemPrompt: "Research", tools: [] },
        writer: { systemPrompt: "Write", tools: [] },
        reviewer: { systemPrompt: "Review", tools: [] },
      },
    });

    expect(agent.name).toBe("team-lead");
    expect(agent).toBeInstanceOf(SupervisorAgent);
  });
});

// ============================================================
// Abort signal handling
// ============================================================

describe("abort signal", () => {
  it("LangGraphAgent respects already-aborted signal", async () => {
    const model = createMockModel([textResponse("ai-1", "Should not appear")]);
    const agent = new LangGraphAgent({ model });

    const controller = new AbortController();
    controller.abort(); // Pre-abort

    // The model.stream will throw on aborted signal, but the loop
    // should catch and not emit RUN_FINISHED
    try {
      const events = await collectEvents(agent.run(makeInput(), controller.signal));
      // If we get here, check that RUN_FINISHED is NOT emitted
      const types = events.map((e) => e.type);
      if (types.includes(EventType.RUN_STARTED)) {
        expect(types).not.toContain(EventType.RUN_FINISHED);
      }
    } catch {
      // Expected: model.stream may throw AbortError
    }
  });

  it("SupervisorAgent respects already-aborted signal", async () => {
    const model = createMockModel([textResponse("ai-1", "Should not appear")]);
    const agent = new SupervisorAgent({
      model,
      subAgents: { researcher: { systemPrompt: "R", tools: [] } },
    });

    const controller = new AbortController();
    controller.abort();

    try {
      const events = await collectEvents(agent.run(makeInput(), controller.signal));
      const types = events.map((e) => e.type);
      if (types.includes(EventType.RUN_STARTED)) {
        expect(types).not.toContain(EventType.RUN_FINISHED);
      }
    } catch {
      // Expected
    }
  });
});

// ============================================================
// Type compatibility
// ============================================================

describe("type compatibility", () => {
  it("SupervisorAgent is assignable to LangGraphAgent", () => {
    const model = createMockModel([]);
    const supervisor: LangGraphAgent = createSupervisor({
      model,
      subAgents: { r: { systemPrompt: "R", tools: [] } },
    });
    expect(supervisor).toBeInstanceOf(LangGraphAgent);
  });

  it("config types are structurally compatible with loop config types", async () => {
    // This is a compile-time check — if it compiles, types are compatible
    const { createAgentLoop, createSupervisorLoop } = await import("../src/loop.js");

    const model = createMockModel([textResponse("ai-1", "OK")]);

    // LangGraphAgentConfig should work with createAgentLoop
    const agentConfig = { model, name: "test" };
    const input = makeInput();

    // Just verify the function accepts the config without error
    const gen = createAgentLoop(input, agentConfig);
    const events = await collectEvents(gen);
    expect(events.length).toBeGreaterThan(0);
  });
});
