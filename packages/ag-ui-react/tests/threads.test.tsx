import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AG_UI_TRACE_EVENT_NAME, type ChatThread } from "../src/types.js";
import { useThreads } from "../src/threads.js";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function renderHook<T>(useHook: () => T) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const result: { current: T | null } = { current: null };

  function TestComponent() {
    result.current = useHook();
    return null;
  }

  act(() => {
    root.render(<TestComponent />);
  });

  return {
    result: result as { current: T },
    unmount() {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    async text() {
      return JSON.stringify(body);
    },
  } as Response;
}

describe("useThreads", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("loads thread summaries on mount and supports select/remove", async () => {
    const list = [
      {
        id: "thread-1",
        title: "First",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        messageCount: 1,
        preview: "Hello",
      },
      {
        id: "thread-2",
        title: "Second",
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        messageCount: 0,
        preview: "",
      },
    ];
    const thread: ChatThread = {
      id: "thread-1",
      title: "First",
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "Hello",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };

    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(list))
      .mockResolvedValueOnce(jsonResponse(thread))
      .mockResolvedValueOnce(jsonResponse(null));

    const hook = renderHook(() =>
      useThreads({
        historyApiUrl: "/history",
        generateId: () => "generated-thread-id",
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/history/threads");
    expect(hook.result.current.list).toEqual(list);

    await act(async () => {
      await hook.result.current.select("thread-1");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(2, "/history/threads/thread-1");
    expect(hook.result.current.activeId).toBe("thread-1");
    expect(hook.result.current.active).toEqual(thread);

    await act(async () => {
      await hook.result.current.remove("thread-1");
    });

    expect(fetchMock).toHaveBeenNthCalledWith(3, "/history/threads/thread-1", {
      method: "DELETE",
    });
    expect(hook.result.current.list).toEqual([
      {
        id: "thread-2",
        title: "Second",
        createdAt: "2024-01-02T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        messageCount: 0,
        preview: "",
      },
    ]);
    expect(hook.result.current.active).toBeNull();
    expect(hook.result.current.activeId).toBeNull();
    hook.unmount();
  });

  it("creates threads locally, reuses provided ids, and appends messages", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const hook = renderHook(() =>
      useThreads({
        generateId: () => "thread-created",
      }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    let createdId = "";
    await act(async () => {
      createdId = await hook.result.current.create();
    });

    expect(createdId).toBe("thread-created");
    expect(hook.result.current.active).toMatchObject({
      id: "thread-created",
      title: "New Chat",
      messages: [],
    });

    await act(async () => {
      hook.result.current.appendMessage({
        id: "user-1",
        role: "user",
        content: "Hello",
        createdAt: "2024-01-03T00:00:00.000Z",
      });
    });

    expect(hook.result.current.active?.messages).toEqual([
      {
        id: "user-1",
        role: "user",
        content: "Hello",
        createdAt: "2024-01-03T00:00:00.000Z",
      },
    ]);

    await act(async () => {
      await expect(
        hook.result.current.ensureActiveThread("existing-thread"),
      ).resolves.toBe("existing-thread");
    });

    await act(async () => {
      await expect(hook.result.current.ensureActiveThread()).resolves.toBe(
        "thread-created",
      );
    });
    hook.unmount();
  });

  it("handles thread events, tracks active steps, and appends tool results", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const hook = renderHook(() =>
      useThreads({
        generateId: () => "tool-message-id",
      }),
    );

    await act(async () => {
      await Promise.resolve();
      await hook.result.current.create();
    });

    const activeThreadId = hook.result.current.activeId!;

    act(() => {
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "step_started",
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "researcher",
        parentStepName: "supervisor",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "assistant_start",
        messageId: "assistant-1",
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "researcher",
        parentStepName: "supervisor",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "assistant_delta",
        messageId: "assistant-1",
        delta: "Hello",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "tool_start",
        parentMessageId: "assistant-1",
        toolCallId: "tool-1",
        toolCallName: "search_web",
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "tool_end",
        toolCallId: "tool-1",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "tool_result_start",
        messageId: "tool-message-stream-1",
        toolCallId: "tool-1",
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "researcher",
        parentStepName: "supervisor",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "tool_result_delta",
        messageId: "tool-message-stream-1",
        toolCallId: "tool-1",
        delta: '{"ok"',
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "tool_result_end",
        messageId: "tool-message-stream-1",
        toolCallId: "tool-1",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "trace_event",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-researcher-1",
          agentName: "researcher",
          kind: "subagent",
        },
      });
    });

    expect(hook.result.current.activeSteps).toEqual([
      expect.objectContaining({
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "researcher",
        parentStepName: "supervisor",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      }),
    ]);
    expect(hook.result.current.active?.messages[0]).toMatchObject({
      id: "assistant-1",
      role: "assistant",
      content: "Hello",
      stepName: "researcher",
      parentStepName: "supervisor",
      stepId: "step-researcher-1",
      parentStepId: "step-supervisor-1",
      stepKind: "subagent",
      agentId: "agent-researcher-1",
      agentName: "researcher",
      toolCalls: [
        {
          id: "tool-1",
          function: {
            name: "search_web",
            arguments: "",
          },
          complete: true,
          agentId: "agent-researcher-1",
          agentName: "researcher",
        },
      ],
    });
    expect(hook.result.current.active?.traceEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "STEP_STARTED",
          stepId: "step-researcher-1",
          parentStepId: "step-supervisor-1",
        }),
        expect.objectContaining({
          type: "TEXT_MESSAGE_START",
          messageId: "assistant-1",
          stepId: "step-researcher-1",
          agentId: "agent-researcher-1",
          agentName: "researcher",
        }),
        expect.objectContaining({
          type: "TOOL_CALL_START",
          toolCallId: "tool-1",
          stepId: "step-researcher-1",
          agentId: "agent-researcher-1",
          agentName: "researcher",
        }),
        expect.objectContaining({
          type: "TOOL_CALL_RESULT_START",
          toolCallId: "tool-1",
          messageId: "tool-message-stream-1",
          agentId: "agent-researcher-1",
          agentName: "researcher",
        }),
        expect.objectContaining({
          type: "TOOL_CALL_RESULT_CHUNK",
          toolCallId: "tool-1",
          messageId: "tool-message-stream-1",
          delta: '{"ok"',
        }),
        expect.objectContaining({
          type: "CUSTOM",
          name: AG_UI_TRACE_EVENT_NAME,
          value: expect.objectContaining({
            type: "span.start",
            agentId: "agent-researcher-1",
            agentName: "researcher",
          }),
        }),
      ]),
    );

    act(() => {
      hook.result.current.appendToolResult(
        activeThreadId,
        "tool-1",
        '{"ok":true}',
      );
    });

    expect(hook.result.current.active?.messages).toHaveLength(2);
    expect(hook.result.current.active?.messages[1]).toMatchObject({
      id: "tool-message-stream-1",
      role: "tool",
      content: '{"ok":true}',
      toolCallId: "tool-1",
    });

    act(() => {
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "run_complete",
      });
    });

    expect(hook.result.current.activeSteps).toEqual([]);
    hook.unmount();
  });

  it("deduplicates repeated step_started events for the same step", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([]));

    const hook = renderHook(() => useThreads());

    await act(async () => {
      await Promise.resolve();
      await hook.result.current.create();
    });

    const activeThreadId = hook.result.current.activeId!;

    act(() => {
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "step_started",
        stepId: "step-writer-1",
        stepName: "writer",
        parentStepName: "supervisor",
      });
      hook.result.current.handleThreadEvent(activeThreadId, {
        type: "step_started",
        stepId: "step-writer-1",
        stepName: "writer",
        parentStepName: "supervisor",
      });
    });

    expect(hook.result.current.activeSteps).toHaveLength(1);
    expect(hook.result.current.activeSteps[0]).toMatchObject({
      stepName: "writer",
      parentStepName: "supervisor",
      stepId: "step-writer-1",
    });
    hook.unmount();
  });
});
