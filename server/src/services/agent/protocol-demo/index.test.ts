import { describe, expect, it } from "vitest";

import { runProtocolDemoAgent } from "./index.js";
import {
  SUPERVISOR_HANDOFF_MESSAGE_ID,
  SUPERVISOR_SUMMARY_MESSAGE_ID,
  WRITER_OUTPUT_MESSAGE_ID,
  WRITER_PROGRESS_MESSAGE_ID,
} from "./events.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

describe("protocol demo agent", () => {
  it("emits distinct supervisor and writer traceable messages for the sub-agent tree demo", async () => {
    const events: Array<Record<string, unknown>> = [];

    for await (const event of runProtocolDemoAgent({
      threadId: "thread-test",
      runId: "run-test",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Run the sub-agent tree demo",
        },
      ],
      tools: [],
      forwardedProps: { streamSubgraphs: true },
    } as never)) {
      events.push(event as unknown as Record<string, unknown>);
    }

    expect(
      events
        .filter((event) => event.type === "TEXT_MESSAGE_START")
        .map((event) => event.messageId),
    ).toEqual([
      SUPERVISOR_HANDOFF_MESSAGE_ID,
      WRITER_PROGRESS_MESSAGE_ID,
      WRITER_OUTPUT_MESSAGE_ID,
      SUPERVISOR_SUMMARY_MESSAGE_ID,
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "transfer_to_writer" &&
          event.parentMessageId === SUPERVISOR_HANDOFF_MESSAGE_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "calculate" &&
          event.parentMessageId === WRITER_PROGRESS_MESSAGE_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "CUSTOM" && event.name === "ag-ui.trace",
      ),
    ).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "calculate" &&
          event.agentName === "writer" &&
          typeof event.agentId === "string",
      ),
    ).toBe(true);
    const outputChunkEvents = events.filter(
      (event) =>
        event.type === "CUSTOM" &&
        [TOOL_RESULT_START_EVENT, TOOL_RESULT_DELTA_EVENT, TOOL_RESULT_END_EVENT].includes(
          String(event.name),
        ),
    );
    expect(outputChunkEvents.length).toBeGreaterThan(0);
    expect(
      outputChunkEvents.some(
        (event) =>
          event.name === TOOL_RESULT_START_EVENT &&
          (event.value as { toolCallId?: string }).toolCallId ===
            "protocol-writer-calc-tool",
      ),
    ).toBe(true);
    expect(
      outputChunkEvents.some(
        (event) =>
          event.name === TOOL_RESULT_DELTA_EVENT &&
          typeof (event.value as { delta?: string }).delta === "string",
      ),
    ).toBe(true);
    expect(
      outputChunkEvents.some(
        (event) =>
          event.name === TOOL_RESULT_END_EVENT &&
          (event.value as { toolCallId?: string }).toolCallId ===
            "protocol-writer-calc-tool",
      ),
    ).toBe(true);
  });
});
