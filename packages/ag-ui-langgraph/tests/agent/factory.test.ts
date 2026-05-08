import { describe, expect, it, vi } from "vitest";

import { createReactAgent, createSupervisor } from "../../src/factory.js";

const reactGraphs: unknown[] = [];
const supervisorWorkflows: unknown[] = [];

vi.mock("@langchain/langgraph/prebuilt", () => ({
  createReactAgent: vi.fn((config: unknown) => {
    const graph = {
      kind: "react-graph",
      config,
      nodes: {},
      streamEvents: async function* () {},
    };
    reactGraphs.push(graph);
    return graph;
  }),
}));

vi.mock("@langchain/langgraph-supervisor", () => ({
  createSupervisor: vi.fn((config: unknown) => {
    const workflow = {
      kind: "supervisor-workflow",
      config,
      compile: vi.fn((compileConfig: unknown) => ({
        kind: "supervisor-graph",
        config,
        compileConfig,
        nodes: {},
        streamEvents: async function* () {},
      })),
    };
    supervisorWorkflows.push(workflow);
    return workflow;
  }),
}));

describe("agent factories", () => {
  it("wraps a LangGraph React agent with default options", () => {
    const model = { modelName: "mock" };
    const tool = { name: "lookup" };

    const agent = createReactAgent({
      model: model as never,
      tools: [tool as never],
      systemPrompt: "Answer briefly",
    });

    expect(agent.name).toBe("agent");
    expect(agent.graph).toBe(reactGraphs.at(-1));
    expect((agent.graph as { config: Record<string, unknown> }).config).toEqual({
      llm: model,
      tools: [tool],
      prompt: "Answer briefly",
    });
  });

  it("builds and wraps a supervisor topology with named sub-agents", () => {
    const model = { modelName: "supervisor-model" };
    const writerModel = { modelName: "writer-model" };
    const eventExtension = { name: "event-extension" };

    const agent = createSupervisor({
      name: "editor",
      model: model as never,
      tools: [{ name: "handoff" } as never],
      systemPrompt: "Coordinate",
      outputMode: "last_message",
      eventExtensions: [eventExtension],
      subAgents: {
        writer: {
          model: writerModel as never,
          systemPrompt: "Write",
          tools: [{ name: "draft" } as never],
        },
        reviewer: {
          systemPrompt: "Review",
          tools: [],
        },
      },
    });

    const workflow = supervisorWorkflows.at(-1) as {
      config: Record<string, unknown>;
      compile: ReturnType<typeof vi.fn>;
    };
    const subAgentConfigs = (workflow.config.agents as Array<{
      config: Record<string, unknown>;
    }>).map((graph) => graph.config);

    expect(agent.name).toBe("editor");
    expect((agent as unknown as { eventExtensions: unknown[] }).eventExtensions).toEqual([
      eventExtension,
    ]);
    expect(agent.graph).toMatchObject({
      kind: "supervisor-graph",
      compileConfig: { name: "editor" },
    });
    expect(workflow.config).toMatchObject({
      llm: model,
      supervisorName: "editor",
      outputMode: "last_message",
      prompt: "Coordinate",
    });
    expect(subAgentConfigs).toMatchObject([
      { llm: writerModel, name: "writer", prompt: "Write" },
      { llm: model, name: "reviewer", prompt: "Review" },
    ]);
  });
});
