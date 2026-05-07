import { describe, expect, it, vi } from "vitest";

import {
  asCheckpointGraph,
  asCheckpointSnapshot,
  getCheckpointBeforeMessage,
  getGraphState,
  getGraphStateHistory,
  snapshotMessages,
  snapshotValues,
  streamGraphEvents,
  stripCheckpointPins,
  updateGraphState,
} from "../../src/runtime/graph.js";

describe("runtime graph helpers", () => {
  it("returns null for graphs without checkpoint methods", async () => {
    expect(asCheckpointGraph(null)).toEqual({});
    await expect(getGraphState({}, {})).resolves.toBeNull();
    await expect(updateGraphState({}, {}, {})).resolves.toBeNull();
  });

  it("delegates checkpoint and stream operations to graph methods", async () => {
    const snapshot = { values: { messages: ["m1"], profile: { id: 1 } } };
    const graph = {
      getState: vi.fn(() => snapshot),
      updateState: vi.fn(() => ({ configurable: { checkpoint_id: "fork" } })),
      streamEvents: vi.fn(async function* () {
        yield { event: "on_chain_start" };
      }),
    };

    await expect(getGraphState(graph, { configurable: { thread_id: "t1" } }))
      .resolves.toBe(snapshot);
    await expect(updateGraphState(graph, { configurable: {} }, { messages: [] }, "node"))
      .resolves.toEqual({ configurable: { checkpoint_id: "fork" } });
    expect(snapshotValues(snapshot)).toEqual(snapshot.values);
    expect(snapshotMessages(snapshot)).toEqual(["m1"]);

    const events = [];
    for await (const event of streamGraphEvents(graph as never, { input: true }, { version: "v2" })) {
      events.push(event);
    }
    expect(events).toEqual([{ event: "on_chain_start" }]);
  });

  it("reads sync and async graph state history", async () => {
    const syncGraph = {
      getStateHistory: () => [{ values: { messages: [] } }, "invalid"],
    };
    await expect(getGraphStateHistory(syncGraph, {})).resolves.toEqual([
      { values: { messages: [] } },
      {},
    ]);

    const asyncGraph = {
      getStateHistory: async function* () {
        yield { values: { messages: ["m1"] } };
      },
    };
    await expect(getGraphStateHistory(asyncGraph, {})).resolves.toEqual([
      { values: { messages: ["m1"] } },
    ]);

    await expect(getGraphStateHistory({}, {})).rejects.toThrow(
      "Graph does not support getStateHistory",
    );
  });

  it("strips checkpoint pins while preserving other config", () => {
    expect(
      stripCheckpointPins(
        {
          configurable: {
            checkpoint_id: "old",
            checkpoint_ns: "ns",
            user_id: "u1",
          },
          tags: ["demo"],
        },
        "thread-1",
      ),
    ).toEqual({
      configurable: {
        user_id: "u1",
        thread_id: "thread-1",
      },
      tags: ["demo"],
    });
  });

  it("finds the checkpoint immediately before a message", async () => {
    const graph = {
      getStateHistory: () => [
        {
          values: {
            messages: [{ id: "u1" }, { id: "a1" }],
            profile: "new",
          },
          config: { configurable: { checkpoint_id: "latest" } },
        },
        {
          values: {
            messages: [{ id: "u1" }],
            profile: "old",
          },
          config: { configurable: { checkpoint_id: "previous" } },
        },
      ],
    };

    await expect(
      getCheckpointBeforeMessage({
        graph,
        messageId: "a1",
        threadId: "thread-1",
        config: {
          configurable: {
            thread_id: "thread-1",
            checkpoint_id: "latest",
            checkpoint_ns: "ns",
          },
        },
      }),
    ).resolves.toEqual({
      values: {
        messages: [{ id: "u1" }],
        profile: "new",
      },
      config: { configurable: { checkpoint_id: "previous" } },
    });
  });

  it("returns an empty-message checkpoint when the first snapshot contains the target", async () => {
    const graph = {
      getStateHistory: () => [
        {
          values: {
            messages: [{ id: "u1" }],
            profile: "first",
          },
        },
      ],
    };

    await expect(
      getCheckpointBeforeMessage({
        graph,
        messageId: "u1",
        threadId: "thread-1",
      }),
    ).resolves.toEqual({
      values: {
        messages: [],
        profile: "first",
      },
    });

    await expect(
      getCheckpointBeforeMessage({
        graph,
        messageId: "missing",
        threadId: "thread-1",
      }),
    ).rejects.toThrow('Message ID "missing" not found');
  });

  it("normalizes invalid snapshots", () => {
    expect(asCheckpointSnapshot(null)).toEqual({});
    expect(snapshotValues(null)).toEqual({});
    expect(snapshotMessages({ values: { messages: "not-array" } })).toEqual([]);
  });
});
