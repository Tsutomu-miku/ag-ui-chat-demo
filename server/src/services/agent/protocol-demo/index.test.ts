import { describe, expect, it } from "vitest";

import { runProtocolDemoAgent } from "./index.js";
import {
  RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
  RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
  SUPERVISOR_HANDOFF_MESSAGE_ID,
  SUPERVISOR_SUMMARY_MESSAGE_ID,
  WRITER_OUTPUT_MESSAGE_ID,
} from "./events.js";

describe("protocol demo agent", () => {
  it("emits parallel researchers followed by a single writer for the sub-agent tree trigger", async () => {
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
          event.parentMessageId === SUPERVISOR_HANDOFF_MESSAGE_ID,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "CUSTOM" &&
          event.name === "ag-ui.trace" &&
          (event.value as { type?: string; name?: string; kind?: string })
            .type === "span.start" &&
          (event.value as { type?: string; name?: string; kind?: string })
            .name === "researcher" &&
          (event.value as { type?: string; name?: string; kind?: string })
            .kind === "subagent",
      ),
    ).toBe(true);
  });

  it("emits separate owner identities for parallel same-name researchers and one final writer", async () => {
    const events: Array<Record<string, unknown>> = [];

    for await (const event of runProtocolDemoAgent({
      threadId: "thread-parallel",
      runId: "run-parallel",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "Run the parallel writer demo",
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
    ).toEqual(
      expect.arrayContaining([
        SUPERVISOR_HANDOFF_MESSAGE_ID,
        RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
        RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
        SUPERVISOR_SUMMARY_MESSAGE_ID,
        WRITER_OUTPUT_MESSAGE_ID,
      ]),
    );

    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_START" &&
          event.messageId === RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID &&
          (event as { owner?: { key?: string } }).owner?.key ===
            "run-parallel:researcher:researcher:alpha",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_START" &&
          event.messageId === RESEARCHER_BETA_OUTPUT_MESSAGE_ID &&
          (event as { owner?: { key?: string } }).owner?.key ===
            "run-parallel:researcher:researcher:beta",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_START" &&
          event.messageId === WRITER_OUTPUT_MESSAGE_ID &&
          (event as { owner?: { key?: string } }).owner?.key ===
            "run-parallel:writer:writer:final",
      ),
    ).toBe(true);

    const supervisorOwnerKeys = [
      ...new Set(
        events
          .filter(
            (event) =>
              event.type === "CUSTOM" &&
              event.name === "ag-ui.trace" &&
              (event.value as { type?: string; kind?: string }).type ===
                "span.start" &&
              (event.value as { kind?: string }).kind === "supervisor",
          )
          .map(
            (event) =>
              (event.value as { owner?: { key?: string } }).owner?.key,
          )
          .filter((value): value is string => Boolean(value)),
      ),
    ];

    expect(supervisorOwnerKeys).toEqual([
      "run-parallel:supervisor:supervisor:root",
    ]);
  });
});
