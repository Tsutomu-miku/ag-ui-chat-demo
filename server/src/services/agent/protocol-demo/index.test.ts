import { describe, expect, it } from "vitest";

import { runProtocolDemoAgent } from "./index.js";
import {
  RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
  RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
  RESEARCHER_HANDOFF_TOOL_CALL_ID,
  SUPERVISOR_HANDOFF_MESSAGE_ID,
  SUPERVISOR_SUMMARY_MESSAGE_ID,
  WRITER_OUTPUT_MESSAGE_ID,
  WRITER_HANDOFF_TOOL_CALL_ID,
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
      RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
      RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
      SUPERVISOR_SUMMARY_MESSAGE_ID,
      WRITER_OUTPUT_MESSAGE_ID,
    ]);
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "transfer_to_researcher" &&
          event.toolCallId === RESEARCHER_HANDOFF_TOOL_CALL_ID &&
          event.parentMessageId === SUPERVISOR_HANDOFF_MESSAGE_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "TOOL_CALL_START" &&
          event.toolCallName === "transfer_to_writer" &&
          event.toolCallId === WRITER_HANDOFF_TOOL_CALL_ID &&
          event.parentMessageId === SUPERVISOR_SUMMARY_MESSAGE_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "CUSTOM" && event.name === "ag-ui.trace",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_START" &&
          event.messageId === WRITER_OUTPUT_MESSAGE_ID &&
          event.agentName === "writer" &&
          typeof event.agentId === "string",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "CUSTOM" &&
          [TOOL_RESULT_START_EVENT, TOOL_RESULT_DELTA_EVENT, TOOL_RESULT_END_EVENT].includes(
            String(event.name),
          ),
      ),
    ).toBe(false);
  });
});
