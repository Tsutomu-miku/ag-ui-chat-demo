import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { handleReasoningEvent } from "../../src/agent/reasoning.js";
import type { RunMetadata } from "../../src/types.js";

function collect(
  activeRun: RunMetadata,
  reasoningData: Parameters<typeof handleReasoningEvent>[1],
  encryptedData: Parameters<typeof handleReasoningEvent>[2],
): BaseEvent[] {
  const events: BaseEvent[] = [];
  for (const event of handleReasoningEvent(
    {
      activeRun,
      dispatchEvent: (event) => {
        events.push(event);
        return event;
      },
    },
    reasoningData,
    encryptedData,
    "message-1",
  )) {
    expect(event).toBe(events.at(-1));
  }
  return events;
}

describe("agent reasoning handler", () => {
  it("starts, streams, and ends a reasoning block", () => {
    const activeRun: RunMetadata = { id: "run-1", reasoning_process: null };

    expect(
      collect(
        activeRun,
        { type: "text", text: "thinking", index: 0, signature: "sig" },
        null,
      ).map((event) => event.type),
    ).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ]);

    expect(collect(activeRun, null, null)).toMatchObject([
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        encryptedValue: "sig",
      },
      { type: EventType.REASONING_MESSAGE_END },
      { type: EventType.REASONING_END },
    ]);
    expect(activeRun.reasoning_process).toBeNull();
  });

  it("emits encrypted reasoning data for active reasoning processes", () => {
    const activeRun: RunMetadata = {
      id: "run-1",
      reasoning_process: {
        index: 0,
        message_id: "message-1",
      },
    };

    expect(collect(activeRun, null, "encrypted")).toMatchObject([
      {
        type: EventType.REASONING_ENCRYPTED_VALUE,
        encryptedValue: "encrypted",
      },
    ]);
  });
});
