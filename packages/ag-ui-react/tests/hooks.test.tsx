import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AG_UI_TRACE_EVENT_NAME,
  type FrontendToolDefinition,
  type ThreadAgentEvent,
} from "../src/types.js";
import { useAgentChat } from "../src/hooks.js";

const TOOL_RESULT_START_EVENT = "ag-ui.tool_result_start";
const TOOL_RESULT_DELTA_EVENT = "ag-ui.tool_result_delta";
const TOOL_RESULT_END_EVENT = "ag-ui.tool_result_end";

type MockSubscriber = Record<string, (...args: any[]) => any>;

const { abortRunMock, runAgentMock, agentInstances } = vi.hoisted(() => ({
  abortRunMock: vi.fn(),
  runAgentMock: vi.fn(),
  agentInstances: [] as Array<{
    url: string;
    threadId?: string;
    messages?: unknown[];
  }>,
}));

vi.mock("@ag-ui/client", () => {
  class MockHttpAgent {
    url: string;
    threadId?: string;
    messages?: unknown[];

    constructor({ url }: { url: string }) {
      this.url = url;
      agentInstances.push(this);
    }

    async runAgent(payload: unknown, subscriber: MockSubscriber) {
      return runAgentMock.call(this, payload, subscriber);
    }

    abortRun() {
      abortRunMock();
    }
  }

  return {
    HttpAgent: MockHttpAgent,
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

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

describe("useAgentChat", () => {
  beforeEach(() => {
    abortRunMock.mockReset();
    runAgentMock.mockReset();
    agentInstances.length = 0;
  });

  it("emits AG-UI events, records frontend tool calls, and clears streaming on finalize", async () => {
    const onThreadEvent = vi.fn();
    const onComplete = vi.fn(async () => {});
    const tool: FrontendToolDefinition = {
      name: "confirm_action",
      description: "Confirm an action",
      parameters: { type: "object" },
    };

    runAgentMock.mockImplementationOnce(
      async (_payload: unknown, subscriber: MockSubscriber) => {
        subscriber.onTextMessageStartEvent({
          event: {
            messageId: "assistant-1",
            stepId: "step-researcher-1",
            parentStepId: "step-supervisor-1",
            stepKind: "subagent",
            stepName: "researcher",
            parentStepName: "supervisor",
          },
        });
        subscriber.onCustomEvent({
          event: {
            type: "CUSTOM",
            name: AG_UI_TRACE_EVENT_NAME,
            value: {
              version: 1,
              type: "message.link",
              messageId: "assistant-1",
              spanId: "span-researcher-1",
              role: "assistant",
            },
          },
        });
        subscriber.onTextMessageContentEvent({
          event: { messageId: "assistant-1", delta: "Hello" },
        });
        subscriber.onToolCallStartEvent({
          event: {
            parentMessageId: "assistant-1",
            toolCallId: "tool-1",
            toolCallName: "confirm_action",
            stepId: "step-researcher-1",
            parentStepId: "step-supervisor-1",
            stepKind: "subagent",
            stepName: "researcher",
          },
        });
        subscriber.onToolCallArgsEvent({
          event: { toolCallId: "tool-1", delta: '{"action":"deploy"}' },
        });
        subscriber.onToolCallEndEvent({
          event: { toolCallId: "tool-1", stepName: "researcher" },
          toolCallName: "confirm_action",
          toolCallArgs: { action: "deploy" },
        });
        subscriber.onCustomEvent({
          event: {
            type: "CUSTOM",
            name: TOOL_RESULT_START_EVENT,
            value: {
              messageId: "tool-message-1",
              toolCallId: "tool-1",
              stepId: "step-researcher-1",
              parentStepId: "step-supervisor-1",
              stepKind: "subagent",
              stepName: "researcher",
            },
          },
        });
        subscriber.onCustomEvent({
          event: {
            type: "CUSTOM",
            name: TOOL_RESULT_DELTA_EVENT,
            value: {
              messageId: "tool-message-1",
              toolCallId: "tool-1",
              delta: '{"approved":',
            },
          },
        });
        subscriber.onCustomEvent({
          event: {
            type: "CUSTOM",
            name: TOOL_RESULT_END_EVENT,
            value: {
              messageId: "tool-message-1",
              toolCallId: "tool-1",
            },
          },
        });
        subscriber.onToolCallResultEvent({
          event: {
            messageId: "tool-message-1",
            toolCallId: "tool-1",
            content: '{"approved":true}',
            stepId: "step-researcher-1",
            parentStepId: "step-supervisor-1",
            stepKind: "subagent",
            stepName: "researcher",
          },
        });
        await subscriber.onRunFinalized();
      },
    );

    const hook = renderHook(() =>
      useAgentChat({
        agentUrl: "/custom-agent",
        frontendTools: [tool],
        onThreadEvent,
        generateId: () => "generated-id",
      }),
    );

    await act(async () => {
      await hook.result.current.sendMessage(
        "thread-1",
        [{ id: "user-0", role: "user", content: "Hi", createdAt: "now" }],
        onComplete,
      );
    });

    expect(agentInstances[0]?.url).toBe("/custom-agent");
    expect(agentInstances[0]?.threadId).toBe("thread-1");
    expect(agentInstances[0]?.messages).toEqual([
      {
        id: "user-0",
        role: "user",
        content: "Hi",
      },
    ]);

    expect(onThreadEvent.mock.calls).toEqual([
      [
        "thread-1",
        {
          type: "assistant_start",
          messageId: "assistant-1",
          stepId: "step-researcher-1",
          parentStepId: "step-supervisor-1",
          stepKind: "subagent",
          stepName: "researcher",
          parentStepName: "supervisor",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "trace_event",
          name: AG_UI_TRACE_EVENT_NAME,
          value: {
            version: 1,
            type: "message.link",
            messageId: "assistant-1",
            spanId: "span-researcher-1",
            role: "assistant",
          },
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "assistant_delta",
          messageId: "assistant-1",
          delta: "Hello",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_start",
          parentMessageId: "assistant-1",
          toolCallId: "tool-1",
          toolCallName: "confirm_action",
          stepId: "step-researcher-1",
          parentStepId: "step-supervisor-1",
          stepKind: "subagent",
          stepName: "researcher",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_args",
          toolCallId: "tool-1",
          delta: '{"action":"deploy"}',
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_end",
          toolCallId: "tool-1",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_result_start",
          messageId: "tool-message-1",
          toolCallId: "tool-1",
          stepId: "step-researcher-1",
          parentStepId: "step-supervisor-1",
          stepKind: "subagent",
          stepName: "researcher",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_result_delta",
          messageId: "tool-message-1",
          toolCallId: "tool-1",
          delta: '{"approved":',
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "tool_result_end",
          messageId: "tool-message-1",
          toolCallId: "tool-1",
        } satisfies ThreadAgentEvent,
      ],
      [
        "thread-1",
        {
          type: "append_message",
          message: expect.objectContaining({
            id: "tool-message-1",
            role: "tool",
            content: '{"approved":true}',
            toolCallId: "tool-1",
            stepId: "step-researcher-1",
            parentStepId: "step-supervisor-1",
            stepKind: "subagent",
            stepName: "researcher",
          }),
        },
      ],
      [
        "thread-1",
        {
          type: "run_complete",
        } satisfies ThreadAgentEvent,
      ],
    ]);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(hook.result.current.pendingToolCalls).toEqual([
      {
        toolCallId: "tool-1",
        toolCallName: "confirm_action",
        args: { action: "deploy" },
        status: "pending",
        stepId: "step-researcher-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "researcher",
      },
    ]);
    expect(hook.result.current.isStreaming).toBe(false);
    hook.unmount();
  });

  it("resolves pending tool calls by sending a tool result message to the same thread", async () => {
    const firstRun = deferred<void>();
    const secondRun = deferred<void>();
    const onComplete = vi.fn(async () => {});

    runAgentMock
      .mockImplementationOnce(
        async (_payload: unknown, subscriber: MockSubscriber) => {
          subscriber.onToolCallStartEvent({
            event: {
              toolCallId: "tool-2",
              toolCallName: "confirm_action",
              stepId: "span-supervisor-1",
              stepKind: "supervisor",
              stepName: "supervisor",
            },
          });
          subscriber.onToolCallEndEvent({
            event: {
              toolCallId: "tool-2",
              stepId: "span-supervisor-1",
              stepKind: "supervisor",
              stepName: "supervisor",
            },
            toolCallName: "confirm_action",
            toolCallArgs: { action: "ship" },
          });
          await subscriber.onRunFinalized();
          firstRun.resolve(undefined);
        },
      )
      .mockImplementationOnce(
        async (_payload: unknown, subscriber: MockSubscriber) => {
          await subscriber.onRunFinalized();
          secondRun.resolve(undefined);
        },
      );

    const hook = renderHook(() =>
      useAgentChat({
        frontendTools: [
          {
            name: "confirm_action",
            description: "Confirm",
            parameters: { type: "object" },
          },
        ],
        generateId: () => "tool-result-id",
      }),
    );

    await act(async () => {
      await hook.result.current.sendMessage(
        "thread-2",
        [{ id: "user-1", role: "user", content: "Ship it", createdAt: "now" }],
        onComplete,
      );
      await firstRun.promise;
    });

    expect(hook.result.current.pendingToolCalls).toHaveLength(1);

    await act(async () => {
      await hook.result.current.resolveToolCall(
        "tool-2",
        '{"approved":true}',
        onComplete,
      );
      await secondRun.promise;
    });

    const secondCallPayload = runAgentMock.mock.calls[1]?.[0] as {
      runId: string;
      tools: unknown[];
    };
    expect(secondCallPayload.runId).toBe("tool-result-id");
    expect(secondCallPayload.tools).toHaveLength(1);
    expect(agentInstances[0]?.threadId).toBe("thread-2");
    expect(agentInstances[0]?.messages).toEqual([
      {
        id: "tool-result-id",
        role: "tool",
        content: '{"approved":true}',
        toolCallId: "tool-2",
        stepId: "span-supervisor-1",
        stepKind: "supervisor",
        stepName: "supervisor",
      },
    ]);
    expect(hook.result.current.pendingToolCalls).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(2);
    hook.unmount();
  });

  it("stops streaming and aborts the active agent run", async () => {
    runAgentMock.mockImplementationOnce(async () => {
      await flushMicrotasks();
    });

    const hook = renderHook(() => useAgentChat());

    await act(async () => {
      await hook.result.current.sendMessage(
        "thread-stop",
        [{ id: "user-stop", role: "user", content: "Hello", createdAt: "now" }],
        async () => {},
      );
    });

    act(() => {
      hook.result.current.stopStreaming();
    });

    expect(abortRunMock).toHaveBeenCalledTimes(1);
    hook.unmount();
  });
});
