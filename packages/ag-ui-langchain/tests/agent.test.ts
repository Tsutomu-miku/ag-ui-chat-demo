/**
 * Tests for agent.ts — LangGraphAgent with graph-based event translation.
 *
 * Uses mock graph objects to test the event translation pipeline
 * without real LLM calls, exactly as the Python version does with
 * mock compiled graphs.
 */

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { AIMessageChunk, ToolMessage as LCToolMessage } from "@langchain/core/messages";
import { describe, expect, it, vi } from "vitest";

import { LangGraphAgent, type LangGraphAgentConfig } from "../src/agent.js";
import { LangGraphEventTypes, CustomEventNames } from "../src/types.js";

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
 * Create a mock compiled graph that emits a sequence of streamEvents.
 * This simulates what LangGraph's CompiledStateGraph.streamEvents() returns.
 */
function createMockGraph(events: Array<{
  event: string;
  name?: string;
  data?: any;
  metadata?: Record<string, any>;
}>): any {
  return {
    nodes: {},
    streamEvents: function(_input: any, _options: any) {
      async function* generate() {
        for (const ev of events) {
          yield {
            event: ev.event,
            name: ev.name ?? "",
            data: ev.data ?? {},
            metadata: ev.metadata ?? {},
          };
        }
      }
      return generate();
    },
  };
}

function makeConfig(graph: any, name = "test-agent"): LangGraphAgentConfig {
  return { name, graph };
}

// ── Text streaming events ──

function textStreamEvents(
  text: string,
  nodeId = "callModel",
  messageId = "ai-msg-1",
): Array<any> {
  const words = text.split(" ");
  const events: any[] = [];

  // on_chat_model_stream for each word
  for (let i = 0; i < words.length; i++) {
    events.push({
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: i === 0 ? words[i] : ` ${words[i]}`,
        }),
      },
      metadata: { langgraph_node: nodeId },
    });
  }

  // on_chat_model_end
  events.push({
    event: LangGraphEventTypes.OnChatModelEnd,
    name: "ChatOpenAI",
    data: { output: new AIMessageChunk({ id: messageId, content: text }) },
    metadata: { langgraph_node: nodeId },
  });

  return events;
}

// ── Tool call streaming events ──

function toolCallStreamEvents(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  nodeId = "callModel",
  messageId = "ai-msg-1",
): Array<any> {
  return [
    // Tool call start chunk
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: [{
            id: toolCallId,
            index: 0,
            name: toolName,
            args: "",
          }],
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
    // Tool call args chunk
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: [{
            id: toolCallId,
            index: 0,
            name: "",
            args: JSON.stringify(args),
          }],
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
    // on_chat_model_end
    {
      event: LangGraphEventTypes.OnChatModelEnd,
      name: "ChatOpenAI",
      data: {},
      metadata: { langgraph_node: nodeId },
    },
  ];
}

function toolEndEvent(
  toolName: string,
  toolCallId: string,
  result: string,
  nodeId = "tools",
): any {
  return {
    event: LangGraphEventTypes.OnToolEnd,
    name: toolName,
    data: {
      output: new LCToolMessage({
        content: result,
        tool_call_id: toolCallId,
        name: toolName,
      }),
    },
    metadata: { langgraph_node: nodeId },
  };
}

// ============================================================
// LangGraphAgent constructor and lifecycle
// ============================================================

describe("LangGraphAgent", () => {
  it("constructs with name and graph", () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({ name: "my-agent", graph });
    expect(agent.name).toBe("my-agent");
    expect(agent.graph).toBe(graph);
  });

  it("constructs with optional description and config", () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({
      name: "agent",
      graph,
      description: "A test agent",
      config: { thread_id: "t-1" },
    });
    expect(agent.description).toBe("A test agent");
  });

  it("clone() returns a new instance with same graph", () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({ name: "original", graph });
    const cloned = agent.clone();

    expect(cloned).not.toBe(agent);
    expect(cloned).toBeInstanceOf(LangGraphAgent);
    expect(cloned.name).toBe("original");
    expect(cloned.graph).toBe(graph);
  });

  it("clone() provides isolated state", () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({ name: "agent", graph });
    const clone1 = agent.clone();
    const clone2 = agent.clone();

    // They should be independent instances
    expect(clone1).not.toBe(clone2);
  });
});

// ============================================================
// Event translation: text streaming
// ============================================================

describe("event translation: text streaming", () => {
  it("translates on_chat_model_stream text to TEXT_MESSAGE_* events", async () => {
    const graph = createMockGraph(textStreamEvents("Hello world", "agent"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("preserves threadId and runId in lifecycle events", async () => {
    const graph = createMockGraph(textStreamEvents("Hi"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(
      agent.clone().run(makeInput({ threadId: "t-123", runId: "r-456" })),
    );

    const started = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    expect(started.threadId).toBe("t-123");
    expect(started.runId).toBe("r-456");

    const finished = events.find((e) => e.type === EventType.RUN_FINISHED) as any;
    expect(finished.threadId).toBe("t-123");
    expect(finished.runId).toBe("r-456");
  });

  it("streams text content as deltas", async () => {
    const graph = createMockGraph(textStreamEvents("Hello world"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const contentEvents = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );

    expect(contentEvents.length).toBe(2);
    expect((contentEvents[0] as any).delta).toBe("Hello");
    expect((contentEvents[1] as any).delta).toBe(" world");
  });

  it("handles empty stream gracefully", async () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({ name: "agent", graph });
    const events = await collectEvents(agent.clone().run(makeInput()));

    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1]).toMatchObject({ type: EventType.RUN_FINISHED });
  });
});

// ============================================================
// Event translation: tool calls
// ============================================================

describe("event translation: tool calls", () => {
  it("translates streamed tool calls to TOOL_CALL_* events", async () => {
    const graph = createMockGraph(
      toolCallStreamEvents("search_web", "tc-1", { query: "test" }),
    );
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    // on_chat_model_end should clean up
    expect(types).toContain(EventType.TOOL_CALL_END);
  });

  it("emits TOOL_CALL_RESULT from on_tool_end", async () => {
    const graph = createMockGraph([
      ...toolCallStreamEvents("search_web", "tc-1", { query: "test" }),
      toolEndEvent("search_web", "tc-1", "Search results here"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const resultEvent = events.find(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    ) as any;

    expect(resultEvent).toBeDefined();
    expect(resultEvent.toolCallId).toBe("tc-1");
    expect(resultEvent.content).toBe("Search results here");
    expect(resultEvent.role).toBe("tool");
  });

  it("emits tool call start/args/end when not previously streamed", async () => {
    // Tool end without prior streaming (has_function_streaming = false)
    const graph = createMockGraph([
      toolEndEvent("calculate", "tc-2", "42"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
  });
});

// ============================================================
// Event translation: step management (node changes)
// ============================================================

describe("event translation: step management", () => {
  it("emits STEP_STARTED/FINISHED on node changes", async () => {
    const graph = createMockGraph([
      // Events from "callModel" node
      ...textStreamEvents("thinking...", "callModel"),
      // Events from "tools" node
      toolEndEvent("search", "tc-1", "result", "tools"),
      // Back to "callModel" node
      ...textStreamEvents("Final answer", "callModel", "ai-msg-2"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));

    const stepStarts = events.filter((e) => e.type === EventType.STEP_STARTED);
    const stepFinishes = events.filter((e) => e.type === EventType.STEP_FINISHED);

    // Should have steps for: callModel, tools, callModel (again)
    expect(stepStarts.length).toBeGreaterThanOrEqual(2);
    expect(stepFinishes.length).toBeGreaterThanOrEqual(1);

    // First step should be callModel
    expect((stepStarts[0] as any).stepName).toBe("callModel");
  });

  it("closes open steps at end of stream", async () => {
    const graph = createMockGraph(textStreamEvents("Hello", "myNode"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const lastStepFinished = events
      .filter((e) => e.type === EventType.STEP_FINISHED)
      .pop();

    expect(lastStepFinished).toBeDefined();
    expect((lastStepFinished as any).stepName).toBe("myNode");
  });
});

// ============================================================
// Event translation: custom events
// ============================================================

describe("event translation: custom events", () => {
  it("translates manually_emit_message to TEXT_MESSAGE events", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnCustomEvent,
        name: CustomEventNames.ManuallyEmitMessage,
        data: { content: "Manual message" },
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    // Also emitted as CUSTOM
    expect(types).toContain(EventType.CUSTOM);
  });

  it("translates manually_emit_tool_call to TOOL_CALL events", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnCustomEvent,
        name: CustomEventNames.ManuallyEmitToolCall,
        data: { id: "tc-manual", name: "my_tool", args: { x: 1 } },
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.CUSTOM);
  });

  it("translates manually_emit_state to STATE_SNAPSHOT", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnCustomEvent,
        name: CustomEventNames.ManuallyEmitState,
        data: { counter: 42 },
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const stateEvents = events.filter(
      (e) => e.type === EventType.STATE_SNAPSHOT,
    );
    expect(stateEvents.length).toBe(1);
    expect((stateEvents[0] as any).snapshot).toEqual({ counter: 42 });
  });

  it("passes through unknown custom events as CUSTOM", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnCustomEvent,
        name: "my_custom_event",
        data: { foo: "bar" },
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const customEvents = events.filter((e) => e.type === EventType.CUSTOM);
    expect(customEvents.length).toBe(1);
    expect((customEvents[0] as any).name).toBe("my_custom_event");
    expect((customEvents[0] as any).value).toEqual({ foo: "bar" });
  });
});

// ============================================================
// Event translation: tool errors
// ============================================================

describe("event translation: tool errors", () => {
  it("on_tool_error resets internal flags without crashing", async () => {
    const graph = createMockGraph([
      ...toolCallStreamEvents("bad_tool", "tc-err", {}),
      {
        event: LangGraphEventTypes.OnToolError,
        name: "bad_tool",
        data: { error: new Error("Tool failed") },
        metadata: { langgraph_node: "tools" },
      },
      ...textStreamEvents("Fallback response", "callModel", "ai-msg-2"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    // Should recover and still produce text
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});

// ============================================================
// Full agent loop integration
// ============================================================

describe("full agent loop", () => {
  it("handles complete text-only conversation", async () => {
    const graph = createMockGraph(textStreamEvents("Hello! How can I help?"));
    const agent = new LangGraphAgent({ name: "assistant", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types).toContain(EventType.STEP_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types).toContain(EventType.STEP_FINISHED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("handles tool call → tool result → text response", async () => {
    const graph = createMockGraph([
      // Model calls a tool
      ...toolCallStreamEvents("get_weather", "tc-w", { city: "Tokyo" }, "callModel"),
      // Tool executes
      toolEndEvent("get_weather", "tc-w", "Sunny, 25°C", "tools"),
      // Model responds with text
      ...textStreamEvents("The weather in Tokyo is sunny, 25°C.", "callModel", "ai-2"),
    ]);
    const agent = new LangGraphAgent({ name: "weather-agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    // Tool call lifecycle
    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);

    // Text response
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);

    // Lifecycle
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("handles multiple tool calls in sequence", async () => {
    const graph = createMockGraph([
      // First tool call
      ...toolCallStreamEvents("search", "tc-1", { q: "a" }, "callModel"),
      toolEndEvent("search", "tc-1", "result-a", "tools"),
      // Second tool call
      ...toolCallStreamEvents("search", "tc-2", { q: "b" }, "callModel", "ai-2"),
      toolEndEvent("search", "tc-2", "result-b", "tools"),
      // Final response
      ...textStreamEvents("Combined results.", "callModel", "ai-3"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));

    const toolResults = events.filter(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    );
    expect(toolResults.length).toBe(2);
    expect((toolResults[0] as any).content).toBe("result-a");
    expect((toolResults[1] as any).content).toBe("result-b");
  });
});
