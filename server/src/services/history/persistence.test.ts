import { EventType, type Message } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { persistHistory } from "./persistence.js";
import { getThread } from "./store.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

describe("persistHistory", () => {
  it("merges text chunks into one assistant message", () => {
    const threadId = `thread-${crypto.randomUUID()}`;
    const inputMessages: Message[] = [
      {
        id: `user-${crypto.randomUUID()}`,
        role: "user",
        content: "hello",
      },
    ];

    persistHistory(threadId, inputMessages, [
      { type: EventType.RUN_STARTED, threadId, runId: "run-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-1", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "assistant-1", delta: "Hel" },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "assistant-1", delta: "lo" },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-1" },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-1" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[1]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
    });
  });

  it("stores tool call args and tool result", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-2" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-2", role: "assistant" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-2",
        toolCallId: "tool-2",
        toolCallName: "calculator",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-2", delta: '{"expression":"2+' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-2", delta: '2"}' },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-2" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "tool-message-2",
        toolCallId: "tool-2",
        content: "4",
        role: "tool",
      },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-2" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-2",
      role: "assistant",
      toolCalls: [
        {
          id: "tool-2",
          type: "function",
          function: {
            name: "calculator",
            arguments: '{"expression":"2+2"}',
          },
        },
      ],
    });
    expect(thread?.messages[1]).toMatchObject({
      id: "tool-message-2",
      role: "tool",
      toolCallId: "tool-2",
      content: "4",
    });
    expect(thread?.traceEvents.some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(
      true,
    );
  });

  it("keeps tool calls on the same assistant message when tool events arrive after text end", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-3" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-3", role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "assistant-3", delta: "Please confirm." },
      { type: EventType.TEXT_MESSAGE_END, messageId: "assistant-3" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-3",
        toolCallId: "tool-3",
        toolCallName: "confirm_action",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "tool-3",
        delta: '{"action":"Deploy production","severity":"high"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "tool-3" },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-3" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-3",
      role: "assistant",
      content: "Please confirm.",
      toolCalls: [
        {
          id: "tool-3",
          type: "function",
          function: {
            name: "confirm_action",
            arguments: '{"action":"Deploy production","severity":"high"}',
          },
        },
      ],
    });
  });

  it("persists partial tool args before tool_end so replay can recover in-progress input", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-partial-tool-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-partial-1", role: "assistant" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-partial-1",
        toolCallId: "tool-partial-1",
        toolCallName: "search_web",
      },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: "tool-partial-1", delta: '{"query":"rea' },
    ]);

    const thread = getThread(threadId);

    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-partial-1",
      role: "assistant",
      toolCalls: [
        {
          id: "tool-partial-1",
          type: "function",
          function: {
            name: "search_web",
            arguments: '{"query":"rea',
          },
        },
      ],
    });
    expect(
      thread?.traceEvents.some(
        (event) =>
          event.type === EventType.TOOL_CALL_ARGS &&
          event.toolCallId === "tool-partial-1",
      ),
    ).toBe(true);
  });

  it("persists streaming tool result chunks before the final tool result arrives", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-partial-result-1" },
      {
        type: EventType.CUSTOM,
        name: TOOL_RESULT_START_EVENT,
        value: {
          messageId: "tool-result-stream-1",
          toolCallId: "tool-stream-1",
          stepId: "step-writer-1",
          parentStepId: "step-supervisor-1",
          stepKind: "subagent",
          stepName: "writer",
          parentStepName: "supervisor",
        },
      },
      {
        type: EventType.CUSTOM,
        name: TOOL_RESULT_DELTA_EVENT,
        value: {
          messageId: "tool-result-stream-1",
          toolCallId: "tool-stream-1",
          delta: '{"draft":"hel',
        },
      },
      {
        type: EventType.CUSTOM,
        name: TOOL_RESULT_END_EVENT,
        value: {
          messageId: "tool-result-stream-1",
          toolCallId: "tool-stream-1",
        },
      },
    ]);

    const thread = getThread(threadId);

    expect(thread?.messages).toEqual([
      expect.objectContaining({
        id: "tool-result-stream-1",
        role: "tool",
        toolCallId: "tool-stream-1",
        content: '{"draft":"hel',
      }),
    ]);
    expect(
      thread?.traceEvents.some(
        (event) =>
          event.type === EventType.CUSTOM && event.name === TOOL_RESULT_DELTA_EVENT,
      ),
    ).toBe(true);
  });

  it("persists step ids and trace events for sub-agent runs", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-trace-1" },
      {
        type: EventType.STEP_STARTED,
        step: {
          id: "step-supervisor-1",
          kind: "supervisor",
          name: "supervisor",
        },
      },
      {
        type: EventType.STEP_STARTED,
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "assistant-writer-1",
        role: "assistant",
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-writer-1",
        delta: "Result",
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "assistant-writer-1",
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        type: EventType.STEP_FINISHED,
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-trace-1" },
    ]);

    const thread = getThread(threadId);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-writer-1",
      role: "assistant",
      content: "Result",
      step: {
        id: "step-writer-1",
        parentId: "step-supervisor-1",
        kind: "subagent",
        name: "writer",
      },
    });
    expect(thread?.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.STEP_STARTED,
          step: expect.objectContaining({
            id: "step-supervisor-1",
            kind: "supervisor",
          }),
          runId: "run-trace-1",
        }),
        expect.objectContaining({
          type: EventType.STEP_STARTED,
          step: expect.objectContaining({
            id: "step-writer-1",
            parentId: "step-supervisor-1",
            kind: "subagent",
            name: "writer",
          }),
        }),
      ]),
    );
  });

  it("does not persist removed ag-ui.trace span custom events", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-trace-v2" },
      {
        type: EventType.CUSTOM,
        name: "ag-ui.trace",
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-writer-1",
          agentName: "writer",
          kind: "subagent",
        },
      },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-trace-v2" },
    ]);

    expect(getThread(threadId)?.traceEvents).toEqual([
      expect.objectContaining({ type: EventType.RUN_STARTED }),
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    ]);
  });
});
