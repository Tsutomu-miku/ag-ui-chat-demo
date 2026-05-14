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
    expect(thread?.events.some((event) => event.type === EventType.TOOL_CALL_RESULT)).toBe(
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

  it("separates supervisor tool calls from a completed subagent message", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-scope-boundary-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "audio-message",
        role: "assistant",
        extra: {
          parentTaskToolCallId: "audio-task",
          subagentRunId: "audio-run",
          subagentName: "audio-composer",
        },
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "audio-message",
        delta: "audio complete",
      },
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "audio-message",
        extra: {
          parentTaskToolCallId: "audio-task",
          subagentRunId: "audio-run",
          subagentName: "audio-composer",
        },
      },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "supervisor-message",
        toolCallId: "scene-tool",
        toolCallName: "effect_house_toolbox",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "scene-tool",
        delta: '{"actions":[]}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "scene-tool" },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-scope-boundary-1" },
    ]);

    const thread = getThread(threadId);

    expect(thread?.messages).toHaveLength(2);
    expect(thread?.messages[0]).toMatchObject({
      id: "audio-message",
      role: "assistant",
      content: "audio complete",
      extra: expect.objectContaining({
        parentTaskToolCallId: "audio-task",
        subagentName: "audio-composer",
      }),
    });
    expect(thread?.messages[0]?.toolCalls).toBeUndefined();
    expect(thread?.messages[1]).toMatchObject({
      id: "supervisor-message",
      role: "assistant",
      toolCalls: [
        {
          id: "scene-tool",
          type: "function",
          function: {
            name: "effect_house_toolbox",
            arguments: '{"actions":[]}',
          },
          complete: true,
        },
      ],
    });
    expect(thread?.messages[1]?.extra?.parentTaskToolCallId).toBeUndefined();
  });

  it("does not write orphan tool args onto the current assistant message", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-orphan-args-1" },
      { type: EventType.TEXT_MESSAGE_START, messageId: "assistant-orphan", role: "assistant" },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "assistant-orphan",
        delta: "Still thinking.",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "missing-tool",
        delta: '{"bad":true}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "missing-tool" },
    ]);

    const thread = getThread(threadId);

    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      id: "assistant-orphan",
      role: "assistant",
      content: "Still thinking.",
    });
    expect(thread?.messages[0]?.toolCalls).toBeUndefined();
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
      thread?.events.some(
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
        },
        extra: {
          visualization: {
            step: {
              id: "step-writer-1",
              parentId: "step-supervisor-1",
              kind: "subagent",
              name: "writer",
            },
          },
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
      thread?.events.some(
        (event) =>
          event.type === EventType.CUSTOM && event.name === TOOL_RESULT_DELTA_EVENT,
      ),
    ).toBe(true);
  });

  it("persists step ids and event records for sub-agent runs", () => {
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
    expect(thread?.events).toEqual(
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

  it("persists extra visualization on standard events", () => {
    const threadId = `thread-${crypto.randomUUID()}`;

    persistHistory(threadId, [], [
      { type: EventType.RUN_STARTED, threadId, runId: "run-extra-1" },
      {
        type: EventType.TOOL_CALL_START,
        parentMessageId: "assistant-extra-1",
        toolCallId: "tool-extra-1",
        toolCallName: "calculate",
        extra: {
          visualization: {
            step: {
              id: "writer:final",
              parentId: "supervisor:root",
              kind: "subagent",
              name: "writer",
            },
            owner: {
              key: "writer:final",
              type: "writer",
              instanceId: "final",
              parentKey: "supervisor:root",
            },
          },
        },
      },
      { type: EventType.RUN_FINISHED, threadId, runId: "run-extra-1" },
    ]);

    expect(threadId).toBeTruthy();
    expect(getThread(threadId)?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: EventType.TOOL_CALL_START,
          toolCallId: "tool-extra-1",
          runId: "run-extra-1",
          extra: expect.objectContaining({
            visualization: expect.objectContaining({
              owner: expect.objectContaining({
                key: "writer:final",
              }),
            }),
          }),
        }),
      ]),
    );
  });
});
