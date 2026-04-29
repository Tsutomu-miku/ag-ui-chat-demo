import { describe, expect, it } from "vitest";

import {
  asLangGraphStreamEvent,
  getPredictStateTools,
  getSubgraphInfo,
  getToolCallChunks,
} from "../src/events/guards.js";
import {
  collectInterrupts,
  detectSubgraphNames,
} from "../src/runtime/graph.js";

describe("runtime event guards", () => {
  it("normalizes unknown stream events without throwing", () => {
    expect(asLangGraphStreamEvent("not-an-event")).toEqual({
      event: "unknown",
      data: "not-an-event",
      metadata: {},
    });

    expect(
      asLangGraphStreamEvent({
        event: "on_custom_event",
        name: "demo",
        data: { ok: true },
        metadata: null,
        run_id: "run-1",
      }),
    ).toEqual({
      event: "on_custom_event",
      name: "demo",
      data: { ok: true },
      metadata: {},
      run_id: "run-1",
    });
  });

  it("extracts multi tool-call chunks by index", () => {
    const chunks = getToolCallChunks({
      tool_call_chunks: [
        { id: "tc-a", index: 0, name: "alpha", args: '{"a":' },
        { id: "tc-b", index: 1, name: "beta", args: '{"b":1}' },
        { index: "invalid" },
      ],
    });

    expect(chunks).toEqual([
      { id: "tc-a", index: 0, name: "alpha", args: '{"a":' },
      { id: "tc-b", index: 1, name: "beta", args: '{"b":1}' },
      { id: undefined, index: undefined, name: undefined, args: undefined },
    ]);
  });

  it("preserves predict_state metadata payloads", () => {
    const predictState = [
      {
        tool: "update_state",
        state_key: "profile",
        tool_argument: "patch",
        extra: true,
      },
      "legacy_tool",
    ];

    expect(getPredictStateTools({ predict_state: predictState })).toEqual(
      predictState,
    );
  });

  it("detects nested subgraph names from compiled graph nodes", () => {
    class CompiledStateGraph {}

    const names = detectSubgraphNames({
      nodes: {
        researcher: { bound: new CompiledStateGraph() },
        writer: { bound: new CompiledStateGraph() },
        callModel: { bound: { constructor: { name: "RunnableSequence" } } },
      },
    });

    expect([...names].sort()).toEqual(["researcher", "writer"]);
  });

  it("identifies subgraph stream boundaries from checkpoint namespaces", () => {
    const info = getSubgraphInfo({
      eventType: "events",
      metadata: {
        langgraph_checkpoint_ns: "researcher:abc|callModel:def",
      },
      subgraphs: new Set(["researcher"]),
      streamSubgraphs: true,
    });

    expect(info).toEqual({
      currentSubgraph: "researcher",
      isSubgraphStream: true,
    });
  });

  it("collects interrupts from iterable task snapshots", () => {
    const tasks = new Set([
      { interrupts: [{ value: { action: "confirm" } }] },
      { interrupts: null },
      {},
    ]);

    expect(collectInterrupts(tasks)).toEqual([
      { value: { action: "confirm" } },
    ]);
  });
});
