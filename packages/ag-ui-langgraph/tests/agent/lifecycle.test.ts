/**
 * Tests for agent.ts — LangGraphAgent with graph-based event translation.
 *
 * Uses mock graph objects to test the event translation pipeline
 * without real LLM calls, exactly as the Python version does with
 * mock compiled graphs.
 *
 * Covers: constructor, clone, lifecycle, text streaming, tool calls,
 * step management, custom events, tool errors, error handling,
 * _dispatchEvent middleware, metadata switches, RawEvent passthrough,
 * forwarded_props, on_chain_end state tracking, predict_state suppression,
 * subgraph boundary detection, orphan tool message filter.
 */

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import {
  AIMessage,
  AIMessageChunk,
  ToolMessage as LCToolMessage,
  HumanMessage as LCHumanMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import { LangGraphAgent, type LangGraphAgentConfig } from "../../src/agent.js";
import { mergeEventExtra } from "../../src/extensions.js";
import { LangGraphEventTypes, CustomEventNames } from "../../src/types.js";

// ── Helpers ──

async function collectEvents(
  gen: AsyncGenerator<BaseEvent>,
): Promise<BaseEvent[]> {
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
    context: [],
    tools: [],
    ...overrides,
  };
}

/**
 * Create a mock compiled graph that emits a sequence of streamEvents.
 * This simulates what LangGraph's CompiledStateGraph.streamEvents() returns.
 */
function createMockGraph(
  events: Array<{
    event: string;
    name?: string;
    data?: any;
    metadata?: Record<string, any>;
    run_id?: string;
  }>,
): any {
  return {
    nodes: {},
    streamEvents: function (_input: any, _options: any) {
      async function* generate() {
        for (const ev of events) {
          yield {
            event: ev.event,
            name: ev.name ?? "",
            data: ev.data ?? {},
            metadata: ev.metadata ?? {},
            run_id: ev.run_id,
          };
        }
      }
      return generate();
    },
  };
}

function createInspectableGraph(
  events: Array<{
    event: string;
    name?: string;
    data?: any;
    metadata?: Record<string, any>;
    run_id?: string;
  }>,
) {
  const streamEvents = vi.fn((_input: any, _options: any) => {
    async function* generate() {
      for (const ev of events) {
        yield {
          event: ev.event,
          name: ev.name ?? "",
          data: ev.data ?? {},
          metadata: ev.metadata ?? {},
          run_id: ev.run_id,
        };
      }
    }
    return generate();
  });

  return {
    nodes: {},
    streamEvents,
  };
}

function makeConfig(graph: any, name = "test-agent"): LangGraphAgentConfig {
  return { name, graph };
}

function withCheckpointNamespace(
  events: Array<{
    event: string;
    name?: string;
    data?: any;
    metadata?: Record<string, any>;
    run_id?: string;
  }>,
  checkpointNamespace: string,
): Array<{
  event: string;
  name?: string;
  data?: any;
  metadata?: Record<string, any>;
  run_id?: string;
}> {
  return events.map((event) => ({
    ...event,
    metadata: {
      ...(event.metadata ?? {}),
      langgraph_checkpoint_ns: checkpointNamespace,
    },
  }));
}

// ── Text streaming events ──

function textStreamEvents(
  text: string,
  nodeId = "callModel",
  messageId = "ai-msg-1",
): Array<any> {
  const words = text.split(" ");
  const events: any[] = [];

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
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: [
            {
              id: toolCallId,
              index: 0,
              name: toolName,
              args: "",
            },
          ],
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: [
            {
              id: toolCallId,
              index: 0,
              name: "",
              args: JSON.stringify(args),
            },
          ],
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
    {
      event: LangGraphEventTypes.OnChatModelEnd,
      name: "ChatOpenAI",
      data: {},
      metadata: { langgraph_node: nodeId },
    },
  ];
}

function multiToolCallStreamEvents(
  toolCalls: Array<{
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    index: number;
  }>,
  nodeId = "callModel",
  messageId = "ai-msg-1",
): Array<any> {
  return [
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: toolCalls.map((toolCall) => ({
            id: toolCall.toolCallId,
            index: toolCall.index,
            name: toolCall.toolName,
            args: "",
          })),
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
    {
      event: LangGraphEventTypes.OnChatModelStream,
      name: "ChatOpenAI",
      data: {
        chunk: new AIMessageChunk({
          id: messageId,
          content: "",
          tool_call_chunks: toolCalls.map((toolCall) => ({
            id: toolCall.toolCallId,
            index: toolCall.index,
            name: "",
            args: JSON.stringify(toolCall.args),
          })),
        }),
      },
      metadata: { langgraph_node: nodeId },
    },
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

  it("passes runtime config through streamEvents config", async () => {
    const graph = createInspectableGraph([]);
    const agent = new LangGraphAgent({
      name: "agent",
      graph: graph as any,
      config: { recursionLimit: 1000, signal: "sig" as any },
    });

    await collectEvents(agent.clone().run(makeInput()));

    expect(graph.streamEvents).toHaveBeenCalledTimes(1);
    expect(graph.streamEvents.mock.calls[0][1]).toMatchObject({
      version: "v2",
      recursionLimit: 1000,
      signal: "sig",
      configurable: expect.objectContaining({
        thread_id: "thread-1",
      }),
    });
    expect(graph.streamEvents.mock.calls[0][1]).not.toHaveProperty("config");
  });

  it("passes runtime config through prepareStream streamEvents options", async () => {
    const graph = createInspectableGraph([]) as any;
    graph.getState = vi.fn(async () => ({ values: { messages: [] } }));
    const agent = new LangGraphAgent({
      name: "agent",
      graph,
      config: { recursionLimit: 1000, signal: "sig" as any },
    });

    await collectEvents(agent.clone().run(makeInput()));

    expect(graph.streamEvents).toHaveBeenCalledTimes(1);
    expect(graph.streamEvents.mock.calls[0][1]).toMatchObject({
      version: "v2",
      recursionLimit: 1000,
      signal: "sig",
      configurable: expect.objectContaining({
        thread_id: "thread-1",
      }),
    });
    expect(graph.streamEvents.mock.calls[0][1]).not.toHaveProperty("config");
  });

  it("generates a runId when input omits one", async () => {
    const graph = createMockGraph([]);
    const agent = new LangGraphAgent({ name: "agent", graph });
    const input = makeInput();
    delete (input as Partial<RunAgentInput>).runId;

    const events = await collectEvents(agent.clone().run(input));
    const started = events.find((e) => e.type === EventType.RUN_STARTED) as any;
    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;

    expect(typeof started.runId).toBe("string");
    expect(started.runId.length).toBeGreaterThan(0);
    expect(finished.runId).toBe(started.runId);
  });

  it("passes stream_subgraphs through streamEvents options", async () => {
    const graph = createInspectableGraph([]);
    const agent = new LangGraphAgent({ name: "agent", graph: graph as any });
    const input = makeInput();
    (input as any).forwardedProps = { streamSubgraphs: false };

    await collectEvents(agent.clone().run(input));

    expect(graph.streamEvents.mock.calls[0][1]).toMatchObject({
      version: "v2",
      subgraphs: false,
    });
  });

  it("reads input/output/config/context schema keys", () => {
    class InspectAgent extends LangGraphAgent {
      read(config: Record<string, any>) {
        return this.getSchemaKeys(config);
      }
    }
    const graph = {
      nodes: {},
      streamEvents: vi.fn(),
      getInputJsonSchema: () => ({ properties: { messages: {}, topic: {} } }),
      getOutputJsonSchema: () => ({ properties: { answer: {} } }),
      configSchema: () => ({ schema: () => ({ properties: { locale: {} } }) }),
      contextSchema: () => ({ schema: () => ({ properties: { userId: {} } }) }),
    };
    const agent = new InspectAgent({ name: "agent", graph: graph as any });

    expect(agent.read({})).toEqual({
      input: ["messages", "topic", "messages", "tools"],
      output: ["answer", "messages", "tools"],
      config: ["locale"],
      context: ["userId"],
    });
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
    expect(clone1).not.toBe(clone2);
  });

  it("detects subgraph nodes", () => {
    const mockSubgraph = { constructor: { name: "CompiledStateGraph" } };
    const graph = createMockGraph([]);
    (graph as any).nodes = {
      researcher: { bound: mockSubgraph },
      writer: { bound: mockSubgraph },
      callModel: { bound: { constructor: { name: "RunnableSequence" } } },
    };
    const agent = new LangGraphAgent({ name: "agent", graph });
    expect((agent as any).subgraphs.size).toBe(2);
    expect((agent as any).subgraphs.has("researcher")).toBe(true);
    expect((agent as any).subgraphs.has("writer")).toBe(true);
    expect((agent as any).subgraphs.has("callModel")).toBe(false);
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

    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;
    expect(finished.threadId).toBe("t-123");
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
    expect(events[events.length - 1]).toMatchObject({
      type: EventType.RUN_FINISHED,
    });
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
    expect(types).toContain(EventType.TOOL_CALL_END);
  });

  it("translates legacy streamed tool calls from additional_kwargs.tool_calls", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: {
            id: "legacy-tool-msg-1",
            content: "",
            additional_kwargs: {
              tool_calls: [
                {
                  id: "tc-legacy-1",
                  index: 0,
                  function: {
                    name: "calculate",
                    arguments: "",
                  },
                },
              ],
            },
          },
        },
        metadata: { langgraph_node: "writer" },
      },
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: {
            id: "legacy-tool-msg-1",
            content: "",
            additional_kwargs: {
              tool_calls: [
                {
                  id: "tc-legacy-1",
                  index: 0,
                  function: {
                    name: "",
                    arguments: '{"expression":"2+2"}',
                  },
                },
              ],
            },
          },
        },
        metadata: { langgraph_node: "writer" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "writer" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    const toolArgs = events.filter(
      (e) => e.type === EventType.TOOL_CALL_ARGS,
    ) as any[];
    const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);

    expect(toolStarts).toHaveLength(1);
    expect(toolArgs).toHaveLength(1);
    expect(toolArgs[0].toolCallId).toBe("tc-legacy-1");
    expect(toolArgs[0].delta).toBe('{"expression":"2+2"}');
    expect(toolEnds).toHaveLength(1);
  });

  it("emits non-streamed tool calls from on_chat_model_end output before tool execution ends", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {
          output: {
            id: "ai-non-stream-tool-1",
            content: "",
            tool_calls: [
              {
                id: "tc-end-1",
                index: 0,
                function: {
                  name: "compose_text",
                  arguments: '{"topic":"demo"}',
                },
              },
            ],
          },
        },
        metadata: { langgraph_node: "writer" },
      },
      toolEndEvent("compose_text", "tc-end-1", "done", "writer"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    const toolArgs = events.filter(
      (e) => e.type === EventType.TOOL_CALL_ARGS,
    ) as any[];
    const toolEnds = events.filter((e) => e.type === EventType.TOOL_CALL_END);
    const toolResults = events.filter(
      (e) => e.type === EventType.TOOL_CALL_RESULT,
    );

    expect(toolStarts).toHaveLength(1);
    expect((toolStarts[0] as any).parentMessageId).toBe("ai-non-stream-tool-1");
    expect(toolArgs).toHaveLength(1);
    expect(toolArgs[0].toolCallId).toBe("tc-end-1");
    expect(toolArgs[0].delta).toBe('{"topic":"demo"}');
    expect(toolEnds).toHaveLength(1);
    expect(toolResults).toHaveLength(1);
  });

  it("does not emit TEXT_MESSAGE_END for tool-only chunks that never started text streaming", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "gen-1777439602-N1EsnVY1DfsuRJFcDchO",
            content: "",
            tool_call_chunks: [
              {
                id: "tc-partial-1",
                index: 0,
                name: "",
                args: "",
              },
            ],
          }),
        },
        metadata: { langgraph_node: "callModel" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "callModel" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const textStarts = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    );
    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    );

    expect(textStarts).toHaveLength(0);
    expect(textEnds).toHaveLength(0);
  });

  it("does not emit TOOL_CALL_ARGS when a chunk only contains args without a known tool start", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "gen-args-only-1",
            content: "",
            tool_call_chunks: [
              {
                id: "ff7a72ff-b999-4d2e-9a79-422f6e7ef906",
                index: 0,
                name: "",
                args: '{"query":"hello"}',
              },
            ],
          }),
        },
        metadata: { langgraph_node: "callModel" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "callModel" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );
    const toolArgs = events.filter((e) => e.type === EventType.TOOL_CALL_ARGS);

    expect(toolStarts).toHaveLength(0);
    expect(toolArgs).toHaveLength(0);
  });

  it("starts text streaming when content arrives after a tool-only placeholder", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "gen-mixed-1",
            content: "",
            tool_call_chunks: [
              {
                id: "tc-partial-2",
                index: 0,
                name: "",
                args: "",
              },
            ],
          }),
        },
        metadata: { langgraph_node: "callModel" },
      },
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "gen-mixed-1",
            content: "Recovered text",
          }),
        },
        metadata: { langgraph_node: "callModel" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "callModel" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const textStarts = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    ) as any[];
    const textContent = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    ) as any[];
    const textEnds = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_END,
    ) as any[];

    expect(textStarts).toHaveLength(1);
    expect(textStarts[0].messageId).toBe("gen-mixed-1");
    expect(textContent).toHaveLength(1);
    expect(textContent[0].messageId).toBe("gen-mixed-1");
    expect(textContent[0].delta).toBe("Recovered text");
    expect(textEnds).toHaveLength(1);
    expect(textEnds[0].messageId).toBe("gen-mixed-1");
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
    const graph = createMockGraph([toolEndEvent("calculate", "tc-2", "42")]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
  });

  it("keeps multiple streamed task tool calls separated by toolCallId", async () => {
    const graph = createMockGraph(
      multiToolCallStreamEvents([
        {
          toolName: "task",
          toolCallId: "tc-task-svg",
          index: 0,
          args: {
            description: "svg-generator",
            subagent_type: "svg-generator",
          },
        },
        {
          toolName: "task",
          toolCallId: "tc-task-audio",
          index: 1,
          args: {
            description: "audio-composer",
            subagent_type: "audio-composer",
          },
        },
      ]),
    );
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const starts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    ) as any[];
    const args = events.filter(
      (e) => e.type === EventType.TOOL_CALL_ARGS,
    ) as any[];
    const ends = events.filter(
      (e) => e.type === EventType.TOOL_CALL_END,
    ) as any[];

    expect(starts.map((e) => e.toolCallId)).toEqual([
      "tc-task-svg",
      "tc-task-audio",
    ]);
    expect(args).toHaveLength(2);
    expect(args[0].toolCallId).toBe("tc-task-svg");
    expect(args[0].delta).toContain("svg-generator");
    expect(args[0].delta).not.toContain("audio-composer");
    expect(args[1].toolCallId).toBe("tc-task-audio");
    expect(args[1].delta).toContain("audio-composer");
    expect(args[1].delta).not.toContain("svg-generator");
    expect(ends.map((e) => e.toolCallId)).toEqual([
      "tc-task-svg",
      "tc-task-audio",
    ]);
  });
});

// ============================================================
// Event translation: step management (node changes)
// ============================================================

describe("event translation: step management", () => {
  it("emits STEP_STARTED/FINISHED on node changes", async () => {
    const graph = createMockGraph([
      ...textStreamEvents("thinking...", "callModel"),
      toolEndEvent("search", "tc-1", "result", "tools"),
      ...textStreamEvents("Final answer", "callModel", "ai-msg-2"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));

    const stepStarts = events.filter((e) => e.type === EventType.STEP_STARTED);
    const stepFinishes = events.filter(
      (e) => e.type === EventType.STEP_FINISHED,
    );

    expect(stepStarts.length).toBeGreaterThanOrEqual(2);
    expect(stepFinishes.length).toBeGreaterThanOrEqual(1);
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

  it("does not emit built-in trace or attribution fields by default", async () => {
    const graph = createMockGraph([
      ...toolCallStreamEvents(
        "search_web",
        "tc-1",
        { q: "weather" },
        "agent",
        "msg-1",
      ),
      toolEndEvent("search_web", "tc-1", "sunny", "tools"),
    ]);
    const agent = new LangGraphAgent({ name: "supervisor", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const customTrace = events.find(
      (event) =>
        event.type === EventType.CUSTOM &&
        (event as { name?: string }).name === "ag-ui.trace",
    );
    const attributed = events.find(
      (event) =>
        event.type === EventType.TOOL_CALL_START &&
        ("agentId" in event || "agentName" in event || "owner" in event),
    );

    expect(customTrace).toBeUndefined();
    expect(attributed).toBeUndefined();
  });

  it("lets extensions add extra to standard events before they are yielded", async () => {
    const graph = createMockGraph(
      withCheckpointNamespace(
        [
          ...toolCallStreamEvents(
            "search_web",
            "tc-1",
            { q: "weather" },
            "agent",
            "msg-1",
          ),
          toolEndEvent("search_web", "tc-1", "sunny", "tools"),
        ],
        "researcher:branch-a|agent:aaa",
      ),
    );
    const agent = new LangGraphAgent({
      name: "supervisor",
      graph,
      eventExtensions: [
        {
          name: "test-extra",
          beforeDispatchEvent(event, context) {
            if (
              event.type === EventType.TOOL_CALL_START ||
              event.type === EventType.TOOL_CALL_ARGS ||
              event.type === EventType.TOOL_CALL_END ||
              event.type === EventType.TOOL_CALL_RESULT
            ) {
              mergeEventExtra(event, {
                test: {
                  nodeName: context.langgraph.nodeName,
                  checkpointNamespace: context.langgraph.checkpointNamespace,
                  langgraphEvent: context.langgraph.event,
                },
              });
            }
          },
        },
      ],
    });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const toolEvents = events.filter(
      (event) =>
        event.type === EventType.TOOL_CALL_START ||
        event.type === EventType.TOOL_CALL_ARGS ||
        event.type === EventType.TOOL_CALL_END ||
        event.type === EventType.TOOL_CALL_RESULT,
    ) as Array<BaseEvent & { extra?: { test?: Record<string, unknown> } }>;

    expect(toolEvents).toHaveLength(4);
    expect(toolEvents.map((event) => event.extra?.test)).toEqual([
      expect.objectContaining({
        nodeName: "agent",
        checkpointNamespace: "researcher:branch-a|agent:aaa",
        langgraphEvent: LangGraphEventTypes.OnChatModelStream,
      }),
      expect.objectContaining({
        nodeName: "agent",
        checkpointNamespace: "researcher:branch-a|agent:aaa",
        langgraphEvent: LangGraphEventTypes.OnChatModelStream,
      }),
      expect.objectContaining({
        nodeName: "agent",
        checkpointNamespace: "researcher:branch-a|agent:aaa",
        langgraphEvent: LangGraphEventTypes.OnChatModelEnd,
      }),
      expect.objectContaining({
        nodeName: "tools",
        checkpointNamespace: "researcher:branch-a|agent:aaa",
        langgraphEvent: LangGraphEventTypes.OnToolEnd,
      }),
    ]);
  });

  it("lets extensions suppress events", async () => {
    const graph = createMockGraph([
      ...toolCallStreamEvents("search_web", "tc-1", { q: "weather" }),
    ]);
    const agent = new LangGraphAgent({
      name: "agent",
      graph,
      eventExtensions: [
        {
          name: "suppress-args",
          beforeDispatchEvent(event) {
            return event.type === EventType.TOOL_CALL_ARGS ? null : event;
          },
        },
      ],
    });

    const events = await collectEvents(agent.clone().run(makeInput()));

    expect(events.some((event) => event.type === EventType.TOOL_CALL_START)).toBe(
      true,
    );
    expect(events.some((event) => event.type === EventType.TOOL_CALL_ARGS)).toBe(
      false,
    );
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
        data: { message_id: "manual-1", message: "Manual message" },
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
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
    // At least one from the custom event; may also get one from state diff tracking
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);
    // The first one should contain the manually emitted state
    // One of the snapshots should contain the manually emitted state
    const hasManualState = stateEvents.some(
      (e) => (e as any).snapshot?.counter === 42,
    );
    expect(hasManualState).toBe(true);
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

    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });
});

// ============================================================
// NEW: Error event handling
// ============================================================

describe("event translation: error events", () => {
  it("translates stream error to RUN_ERROR and stops", async () => {
    const graph = createMockGraph([
      ...textStreamEvents("starting", "agent"),
      {
        event: "error",
        name: "",
        data: { message: "LLM rate limit exceeded" },
        metadata: {},
      },
      // These should NOT be reached
      ...textStreamEvents("after error", "agent", "ai-2"),
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.RUN_ERROR);
    const errorEvent = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as any;
    expect(errorEvent.message).toBe("LLM rate limit exceeded");
  });

  it("handles error event without message gracefully", async () => {
    const graph = createMockGraph([{ event: "error", data: {}, metadata: {} }]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const errorEvent = events.find(
      (e) => e.type === EventType.RUN_ERROR,
    ) as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toBe("Unknown error");
  });
});

// ============================================================
// NEW: _dispatchEvent middleware
// ============================================================

describe("_dispatchEvent middleware", () => {
  it("allows subclass to filter events", async () => {
    class FilterAgent extends LangGraphAgent {
      protected _dispatchEvent(event: BaseEvent): BaseEvent | null {
        // Suppress all RAW events
        if (event.type === EventType.RAW) return null;
        return event;
      }
    }

    const graph = createMockGraph(textStreamEvents("Hello"));
    const agent = new FilterAgent({ name: "filter", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const rawEvents = events.filter((e) => e.type === EventType.RAW);
    expect(rawEvents.length).toBe(0);
    // Other events should still come through
    expect(events.some((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)).toBe(
      true,
    );
  });

  it("allows subclass to transform events", async () => {
    class TransformAgent extends LangGraphAgent {
      protected _dispatchEvent(event: BaseEvent): BaseEvent | null {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          return { ...event, delta: (event as any).delta.toUpperCase() } as any;
        }
        return event;
      }
    }

    const graph = createMockGraph(textStreamEvents("hello"));
    const agent = new TransformAgent({ name: "transform", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const content = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );
    expect((content[0] as any).delta).toBe("HELLO");
  });
});

// ============================================================
// NEW: RawEvent passthrough
// ============================================================

describe("RawEvent passthrough", () => {
  it("emits RAW event for every stream event", async () => {
    const graph = createMockGraph(textStreamEvents("Hi", "node1"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const rawEvents = events.filter((e) => e.type === EventType.RAW);

    // Should have at least as many RAW events as there are stream events
    // textStreamEvents("Hi") = 1 on_chat_model_stream + 1 on_chat_model_end = 2
    expect(rawEvents.length).toBeGreaterThanOrEqual(2);
    expect((rawEvents[0] as any).event).toBeDefined();
    expect((rawEvents[0] as any).event.event).toBe(
      LangGraphEventTypes.OnChatModelStream,
    );
  });

  it("serializes recursive RAW event payloads safely", async () => {
    const recursive: any = { label: "cycle" };
    recursive.self = recursive;
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnCustomEvent,
        name: "recursive",
        data: recursive,
        metadata: {},
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const rawEvent = events.find((e) => e.type === EventType.RAW) as any;

    expect(rawEvent.event.data.self).toBe("<recursive>");
  });
});

// ============================================================
// NEW: Metadata switches (emit-messages, emit-tool-calls)
// ============================================================

describe("metadata switches", () => {
  it("suppresses text messages when emit-messages=false", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({ id: "msg-1", content: "suppressed" }),
        },
        metadata: { langgraph_node: "agent", "emit-messages": false },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent", "emit-messages": false },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const textStarts = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_START,
    );
    const textContent = events.filter(
      (e) => e.type === EventType.TEXT_MESSAGE_CONTENT,
    );

    expect(textStarts.length).toBe(0);
    expect(textContent.length).toBe(0);
  });

  it("suppresses tool calls when emit-tool-calls=false", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "msg-1",
            content: "",
            tool_call_chunks: [
              { id: "tc-1", index: 0, name: "my_tool", args: "" },
            ],
          }),
        },
        metadata: { langgraph_node: "agent", "emit-tool-calls": false },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const toolStarts = events.filter(
      (e) => e.type === EventType.TOOL_CALL_START,
    );

    expect(toolStarts.length).toBe(0);
  });
});

// ============================================================
// NEW: forwarded_props + camelCase→snake_case
// ============================================================

describe("forwarded_props", () => {
  it("normalizes camelCase forwarded_props to snake_case", async () => {
    const graph = createMockGraph(textStreamEvents("ok"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    // Should not throw when forwardedProps has camelCase keys
    const input = makeInput();
    (input as any).forwardedProps = {
      nodeName: "myNode",
      streamSubgraphs: true,
    };

    const events = await collectEvents(agent.clone().run(input));
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("handles input without forwarded_props", async () => {
    const graph = createMockGraph(textStreamEvents("ok"));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    expect(events[0].type).toBe(EventType.RUN_STARTED);
    expect(events[events.length - 1].type).toBe(EventType.RUN_FINISHED);
  });

  it("short-circuits active interrupts when no resume command is provided", async () => {
    const graph = createInspectableGraph([]) as any;
    graph.getState = vi.fn(async () => ({
      values: { messages: [] },
      tasks: [{ interrupts: [{ value: { action: "confirm" } }] }],
    }));
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));

    expect(graph.streamEvents).not.toHaveBeenCalled();
    expect(events.map((e) => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);
    expect((events[1] as any).name).toBe(LangGraphEventTypes.OnInterrupt);
    expect((events[1] as any).value).toEqual({ action: "confirm" });
  });

  it("uses Command input when resuming from forwarded_props.command.resume", async () => {
    const graph = createInspectableGraph([]) as any;
    graph.getState = vi.fn(async () => ({
      values: { messages: [] },
      tasks: [{ interrupts: [] }],
    }));
    const agent = new LangGraphAgent({ name: "agent", graph });
    const input = makeInput();
    (input as any).forwardedProps = {
      command: { resume: '{"approved":true}' },
    };

    await collectEvents(agent.clone().run(input));

    expect(graph.streamEvents.mock.calls[0][0]).toBeInstanceOf(Command);
    expect((graph.streamEvents.mock.calls[0][0] as any).resume).toEqual({
      approved: true,
    });
  });
});

// ============================================================
// NEW: on_chain_end state tracking
// ============================================================

describe("on_chain_end state tracking", () => {
  it("emits STATE_SNAPSHOT on node exit with state diff", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({ id: "msg-1", content: "hello" }),
        },
        metadata: { langgraph_node: "agent" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent" },
      },
      // on_chain_end with output state update
      {
        event: LangGraphEventTypes.OnChainEnd,
        name: "agent",
        data: { output: { custom_key: "value123" } },
        metadata: { langgraph_node: "agent" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const snapshots = events.filter((e) => e.type === EventType.STATE_SNAPSHOT);

    // Should have at least one state snapshot from the chain_end state diff
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================
// NEW: predict_state suppression
// ============================================================

describe("predict_state suppression", () => {
  it("emits PredictState custom event when predict_state metadata present", async () => {
    const predictMeta = [
      { tool: "update_state", state_key: "counter", tool_argument: "value" },
    ];
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({
            id: "msg-1",
            content: "",
            tool_call_chunks: [
              { id: "tc-ps", index: 0, name: "update_state", args: "" },
            ],
          }),
        },
        metadata: { langgraph_node: "agent", predict_state: predictMeta },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const customEvents = events.filter(
      (e) => e.type === EventType.CUSTOM && (e as any).name === "PredictState",
    );
    expect(customEvents.length).toBe(1);
    expect((customEvents[0] as any).value).toEqual(predictMeta);
  });
});

// ============================================================
// NEW: Orphan tool message filter
// ============================================================

describe("orphan tool message filter", () => {
  it("filters out orphan tool messages after last HumanMessage", () => {
    const agent = new LangGraphAgent({
      name: "agent",
      graph: createMockGraph([]),
    });
    const filterFn = (agent as any)._filterOrphanToolMessages.bind(agent);

    const humanMsg = new LCHumanMessage({ content: "hello" });
    const toolMsg = new LCToolMessage({
      content: "Error: No tool call found with id tc-123",
      tool_call_id: "tc-123",
    });
    const normalToolMsg = new LCToolMessage({
      content: "Result: 42",
      tool_call_id: "tc-456",
    });

    const messages = [humanMsg, toolMsg, normalToolMsg];
    const filtered = filterFn(messages);

    expect(filtered.length).toBe(2);
    expect(filtered[0]).toBe(humanMsg);
    expect(filtered[1]).toBe(normalToolMsg);
  });

  it("preserves all messages when no orphans", () => {
    const agent = new LangGraphAgent({
      name: "agent",
      graph: createMockGraph([]),
    });
    const filterFn = (agent as any)._filterOrphanToolMessages.bind(agent);

    const humanMsg = new LCHumanMessage({ content: "hello" });
    const toolMsg = new LCToolMessage({
      content: "Valid result",
      tool_call_id: "tc-1",
    });

    const filtered = filterFn([humanMsg, toolMsg]);
    expect(filtered.length).toBe(2);
  });
});

// ============================================================
// State merge alignment
// ============================================================

describe("state merge alignment", () => {
  it("dedupes checkpoint messages, repairs orphan tool content, and exposes ag-ui state", () => {
    const agent = new LangGraphAgent({
      name: "agent",
      graph: createMockGraph([]),
    });
    const merge = (agent as any).langgraphDefaultMergeState.bind(agent);
    const existingHuman = new LCHumanMessage({ id: "h-1", content: "hello" });
    const existingAi = new AIMessage({
      id: "ai-1",
      content: "",
      tool_calls: [
        {
          id: "tc-1",
          name: "confirm_action",
          args: { action: "deploy" },
          type: "tool_call",
        },
      ],
    });
    const orphanTool = new LCToolMessage({
      id: "tool-orphan",
      content:
        "Tool call 'confirm_action' with id 'tc-1' was interrupted before completion.",
      tool_call_id: "tc-1",
    });
    const incomingTool = new LCToolMessage({
      id: "tool-real",
      content: "approved",
      tool_call_id: "tc-1",
    });
    const input = makeInput({
      tools: [
        {
          name: "confirm_action",
          description: "fresh frontend tool",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "collect_user_input",
          description: "second frontend tool",
          parameters: { type: "object", properties: {} },
        },
      ],
      context: [
        {
          description:
            "A2UI Component Schema — available components for generating UI surfaces.\nUse these component names and props when creating A2UI operations.",
          value: { components: ["Panel"] },
        },
        { description: "regular", value: { locale: "en" } },
      ],
    } as any);

    const result = merge(
      {
        messages: [existingHuman, existingAi, orphanTool],
        tools: [{ name: "confirm_action", description: "stale" }],
        copilotkit: { preserved: true },
      },
      [incomingTool],
      input,
    );

    expect(orphanTool.content).toBe("approved");
    expect(result.messages).toEqual([]);
    expect((existingAi.tool_calls?.[0] as any).args).toEqual({
      action: "deploy",
    });
    expect(result.tools.map((tool: any) => tool.name)).toEqual([
      "confirm_action",
      "collect_user_input",
    ]);
    expect(result["ag-ui"]).toMatchObject({
      tools: result.tools,
      context: [{ description: "regular", value: { locale: "en" } }],
      a2ui_schema: { components: ["Panel"] },
    });
    expect(result.copilotkit).toMatchObject({
      preserved: true,
      actions: result.tools,
    });
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
      ...toolCallStreamEvents(
        "get_weather",
        "tc-w",
        { city: "Tokyo" },
        "callModel",
      ),
      toolEndEvent("get_weather", "tc-w", "Sunny, 25°C", "tools"),
      ...textStreamEvents(
        "The weather in Tokyo is sunny, 25°C.",
        "callModel",
        "ai-2",
      ),
    ]);
    const agent = new LangGraphAgent({ name: "weather-agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const types = events.map((e) => e.type);

    expect(types).toContain(EventType.TOOL_CALL_START);
    expect(types).toContain(EventType.TOOL_CALL_ARGS);
    expect(types).toContain(EventType.TOOL_CALL_END);
    expect(types).toContain(EventType.TOOL_CALL_RESULT);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
    expect(types[0]).toBe(EventType.RUN_STARTED);
    expect(types[types.length - 1]).toBe(EventType.RUN_FINISHED);
  });

  it("handles multiple tool calls in sequence", async () => {
    const graph = createMockGraph([
      ...toolCallStreamEvents("search", "tc-1", { q: "a" }, "callModel"),
      toolEndEvent("search", "tc-1", "result-a", "tools"),
      ...toolCallStreamEvents(
        "search",
        "tc-2",
        { q: "b" },
        "callModel",
        "ai-2",
      ),
      toolEndEvent("search", "tc-2", "result-b", "tools"),
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

  it("keeps the outer runId stable when stream events carry internal run_id values", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({ id: "msg-1", content: "hi" }),
        },
        metadata: { langgraph_node: "agent" },
        run_id: "updated-run-id",
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent" },
        run_id: "updated-run-id",
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));
    const finished = events.find(
      (e) => e.type === EventType.RUN_FINISHED,
    ) as any;
    // The outer AG-UI runId must stay stable and must not be overwritten by
    // internal LangGraph event run_id values.
    expect(finished.runId).toBe("run-1");
  });

  it("does not emit step events for the internal __start__ node", async () => {
    const graph = createMockGraph([
      {
        event: LangGraphEventTypes.OnChainStart,
        name: "__start__",
        data: {},
        metadata: { langgraph_node: "__start__" },
      },
      {
        event: LangGraphEventTypes.OnChatModelStream,
        name: "ChatOpenAI",
        data: {
          chunk: new AIMessageChunk({ id: "msg-1", content: "hi" }),
        },
        metadata: { langgraph_node: "agent" },
      },
      {
        event: LangGraphEventTypes.OnChatModelEnd,
        name: "ChatOpenAI",
        data: {},
        metadata: { langgraph_node: "agent" },
      },
    ]);
    const agent = new LangGraphAgent({ name: "agent", graph });

    const events = await collectEvents(agent.clone().run(makeInput()));

    expect(
      events.some(
        (event) =>
          event.type === EventType.STEP_STARTED &&
          (event as { stepName?: string }).stepName === "__start__",
      ),
    ).toBe(false);
  });
});
