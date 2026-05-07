import { EventType } from "@ag-ui/core";
import { HumanMessage, AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  buildInterruptEvents,
  buildPreparedStreamInput,
  findRegenerationMessage,
} from "../../src/agent/stream-preparation.js";

describe("stream preparation helpers", () => {
  it("detects a regeneration message when checkpoint history is ahead", () => {
    const user = new HumanMessage({ id: "u1", content: "again" });
    const result = findRegenerationMessage({
      checkpointMessages: [{ id: "old-user" }, { id: "u1" }, { id: "a1" }],
      langchainMessages: [
        new HumanMessage({ id: "new-user", content: "new branch" }),
        user,
      ],
    });

    expect(result).toBe(user);
  });

  it("does not regenerate when incoming messages are a continuation", () => {
    expect(
      findRegenerationMessage({
        checkpointMessages: [{ id: "u1" }, { id: "a1" }],
        langchainMessages: [
          new HumanMessage({ id: "u1", content: "hi" }),
          new AIMessage({ id: "a1", content: "hello" }),
        ],
      }),
    ).toBeNull();
  });

  it("builds interrupt short-circuit lifecycle events", () => {
    expect(
      buildInterruptEvents({
        activeRun: { id: "run-1" },
        threadId: "thread-1",
        interrupts: [{ value: { kind: "confirm" } }],
      }),
    ).toEqual([
      {
        type: EventType.RUN_STARTED,
        threadId: "thread-1",
        runId: "run-1",
      },
      {
        type: EventType.CUSTOM,
        name: "on_interrupt",
        value: { kind: "confirm" },
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "thread-1",
        runId: "run-1",
      },
    ]);
  });

  it("builds start payload or Command resume stream input", () => {
    expect(
      buildPreparedStreamInput({
        activeRun: { id: "run-1", mode: "start" },
        forwardedProps: { stream_subgraphs: true },
        resumeInput: null,
        state: { messages: [], private: true, profile: { name: "A" } },
        schemaKeys: { input: ["profile"] },
      }),
    ).toEqual({
      stream_subgraphs: true,
      profile: { name: "A" },
    });

    const resume = buildPreparedStreamInput({
      activeRun: { id: "run-1", mode: "continue" },
      forwardedProps: {},
      resumeInput: { answer: "yes" },
      state: {},
    });
    expect(resume?.constructor?.name).toBe("Command");
  });
});
