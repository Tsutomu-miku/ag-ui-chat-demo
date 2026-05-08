import { describe, expect, it } from "vitest";
import type { ActiveStep, AgentEventRecord, ChatMessage } from "ag-ui-react";

import {
  buildAgentTraceData,
  buildTimelineTraceEntries,
  buildTurnPresentation,
  getDelegationInput,
  getMessageSourceLabel,
  getTraceMode,
  getToolInputDisplay,
  getToolResultDisplay,
} from "./model";

function assistantMessage(
  id: string,
  content: string,
  stepName?: string,
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    ...(stepName ? { stepName } : {}),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function activeStep(stepName: string, parentStepName?: string): ActiveStep {
  return {
    stepName,
    step: {
      id: parentStepName ? `step-${stepName}-1` : `step-${stepName}-root`,
      ...(parentStepName ? { parentId: `step-${parentStepName}-root` } : {}),
      kind: parentStepName ? "subagent" : "supervisor",
      name: stepName,
    },
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("trace model", () => {
  it("keeps plain assistant replies out of trace mode", () => {
    const messages = [
      assistantMessage("assistant-1", "Plain answer", "supervisor"),
    ];

    expect(getTraceMode(messages, [])).toBe("none");
    expect(buildTurnPresentation(messages, []).standaloneMessages).toHaveLength(
      1,
    );
  });

  it("keeps complete assistant messages outside the tree for non-agent traces", () => {
    const messages: ChatMessage[] = [
      assistantMessage("assistant-1", "I will look that up.", "assistant"),
      {
        ...assistantMessage(
          "assistant-2",
          "The weather is sunny.",
          "assistant",
        ),
        toolCalls: [
          {
            id: "tool-weather",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
            complete: true,
            step: { name: "assistant" },
          },
        ],
      },
    ];

    const presentation = buildTurnPresentation(messages, []);

    expect(presentation.traceMode).toBe("timeline");
    expect(
      presentation.standaloneMessages.map((message) => message.id),
    ).toEqual(["assistant-1", "assistant-2"]);
  });

  it("switches agent traces into tree mode without dropping the underlying node content", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "Routing to writer", "supervisor"),
        toolCalls: [
          {
            id: "tool-transfer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"calculate and explain"}',
            },
            complete: true,
            step: { name: "supervisor" },
          },
        ],
      },
      {
        ...assistantMessage(
          "assistant-2",
          "The result is 1057.33...",
          "writer",
        ),
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-root",
          kind: "subagent",
          name: "writer",
        },
      },
    ];
    const activeSteps: ActiveStep[] = [
      {
        stepName: "supervisor",
        step: {
          id: "step-supervisor-root",
          kind: "supervisor",
          name: "supervisor",
        },
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        stepName: "writer",
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-root",
          kind: "subagent",
          name: "writer",
        },
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    const presentation = buildTurnPresentation(messages, activeSteps);
    const traceData = buildAgentTraceData(messages, activeSteps);

    expect(presentation.traceMode).toBe("agent");
    expect(
      traceData?.nodes["step-writer-1"]?.messages.map((message) => message.id),
    ).toEqual(["assistant-2"]);
    expect(getMessageSourceLabel(messages[1]!)).toBe("Writer");
  });

  it("does not derive agent source labels from step name alone", () => {
    const message = assistantMessage("assistant-1", "Writer answer", "writer");

    expect(getMessageSourceLabel(message)).toBeUndefined();
  });

  it("extracts explicit delegation input from handoff tool args", () => {
    expect(
      getDelegationInput({
        function: {
          name: "transfer_to_writer",
          arguments: '{"input":"Calculate and explain the result"}',
        },
      }),
    ).toBe("Calculate and explain the result");
  });

  it("keeps streaming tool args raw until the tool call completes", () => {
    expect(
      getToolInputDisplay({
        function: {
          name: "search_web",
          arguments: '{"query":"hel',
        },
        complete: false,
      }),
    ).toEqual({
      content: '{"query":"hel',
      isStreaming: true,
    });

    expect(
      getToolInputDisplay({
        function: {
          name: "search_web",
          arguments: '{"query":"hello"}',
        },
        complete: true,
      }),
    ).toEqual({
      content: '{\n  "query": "hello"\n}',
      isStreaming: false,
    });
  });

  it("keeps streaming tool results raw until the tool result completes", () => {
    expect(
      getToolResultDisplay({
        content: '{"res',
        isStreaming: true,
      }),
    ).toEqual({
      content: '{"res',
      isStreaming: true,
    });

    expect(
      getToolResultDisplay({
        content: '{"result":4}',
        isStreaming: false,
      }),
    ).toEqual({
      content: '{\n  "result": 4\n}',
      isStreaming: false,
    });
  });

  it("does not fabricate a supervisor root when only writer activity is present", () => {
    const messages = [
      assistantMessage("assistant-1", "Writer answer", "writer"),
    ];
    const traceData = buildAgentTraceData(messages, [activeStep("writer")]);

    expect(traceData?.roots).toEqual(["step-writer-root"]);
    expect(
      Object.values(traceData?.nodes ?? {}).some(
        (node) => node.stepName === "supervisor",
      ),
    ).toBe(false);
  });

  it("keeps a child node as root when its parent node is missing", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-1", "Writer answer", "writer"),
        extra: {
          visualization: {
            step: {
              id: "writer:one",
              parentId: "supervisor:root",
              kind: "subagent",
              name: "writer",
            },
            owner: {
              key: "writer:one",
              type: "writer",
              instanceId: "one",
              parentKey: "supervisor:root",
            },
          },
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], []);

    expect(traceData?.roots).toEqual(["writer:one"]);
    expect(traceData?.nodes["supervisor:root"]).toBeUndefined();
  });

  it("keeps flat assistant/tool traffic in timeline mode when protocol lacks parent-child metadata", () => {
    const messages: ChatMessage[] = [
      assistantMessage(
        "assistant-1",
        "I'll transfer this to the writer agent to handle both the calculation and the explanation.",
      ),
      {
        id: "tool-1",
        role: "tool",
        content: "Successfully transferred to writer",
        toolCallId: "transfer-1",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      assistantMessage(
        "assistant-2",
        "I'll calculate the expression and then explain the result in a paragraph.",
      ),
      {
        id: "tool-2",
        role: "tool",
        content:
          '{"expression":"(23 * 45) + (67 / 3)","result":1057.3333333333333}',
        toolCallId: "calc-1",
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      assistantMessage("assistant-3", "The calculation yields 1057.33."),
      assistantMessage(
        "assistant-4",
        "Perfect! I've completed both parts of your request.",
      ),
    ];

    expect(getTraceMode(messages, [])).toBe("timeline");

    const presentation = buildTurnPresentation(messages, []);
    expect(
      presentation.standaloneMessages.map((message) => message.id),
    ).toEqual(["assistant-1", "assistant-2", "assistant-3", "assistant-4"]);
    expect(buildAgentTraceData(messages, [])).toBeNull();
  });

  it("builds timeline tools only from explicit assistant tool calls", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "Let me calculate that."),
        toolCalls: [
          {
            id: "tool-calc-1",
            type: "function",
            function: {
              name: "calculate",
              arguments: '{"expression":"2+2"}',
            },
            complete: true,
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        content: '{"expression":"2+2","result":4}',
        toolCallId: "tool-calc-1",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    expect(
      buildTimelineTraceEntries(messages).map((entry) => entry.toolCall.id),
    ).toEqual(["tool-calc-1"]);
  });

  it("does not fabricate timeline tools from tool result messages alone", () => {
    const messages: ChatMessage[] = [
      {
        id: "tool-result-1",
        role: "tool",
        content: '{"expression":"2+2","result":4}',
        toolCallId: "tool-calc-1",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    expect(buildTimelineTraceEntries(messages)).toEqual([]);
  });

  it("does not fabricate an agent tree for node-only messages without parent metadata", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage(
          "assistant-1",
          "I'll transfer this request to the writer agent.",
        ),
        step: {
          id: "step-node-1",
          kind: "node",
        },
      },
      {
        id: "tool-1",
        role: "tool",
        content: "Successfully transferred to writer",
        toolCallId: "transfer-1",
        step: {
          id: "step-tools-1",
          kind: "node",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        ...assistantMessage("assistant-2", "Final answer from some node."),
        step: {
          id: "step-node-2",
          kind: "node",
        },
      },
    ];

    expect(getTraceMode(messages, [])).toBe("timeline");
    expect(buildAgentTraceData(messages, [])).toBeNull();
  });

  it("ignores internal __start__ steps in visualization payloads", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "internal"),
        extra: {
          visualization: {
            step: {
              id: "__start__",
              kind: "agent",
              name: "__start__",
            },
            owner: {
              key: "__start__",
              type: "__start__",
              instanceId: "__start__",
            },
          },
        },
      },
    ];

    expect(getTraceMode(messages, [])).toBe("none");
    expect(buildAgentTraceData(messages, [])).toBeNull();
  });

  it("builds a stepId-based tree from event history without merging same-name sub-agents", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-1", "Draft one", "writer"),
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        ...assistantMessage("assistant-writer-2", "Draft two", "writer"),
        step: {
          id: "step-writer-2",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
    ];
    const events: AgentEventRecord[] = [
      {
        type: "STEP_STARTED",
        step: {
          id: "step-supervisor-1",
          kind: "supervisor",
          name: "supervisor",
        },
      },
      {
        type: "STEP_STARTED",
        step: {
          id: "step-writer-1",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
      {
        type: "STEP_STARTED",
        step: {
          id: "step-writer-2",
          parentId: "step-supervisor-1",
          kind: "subagent",
          name: "writer",
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], events);

    expect(traceData?.roots).toEqual(["step-supervisor-1"]);
    expect(traceData?.nodes["step-supervisor-1"]?.childStepIds).toEqual([
      "step-writer-1",
      "step-writer-2",
    ]);
    expect(
      traceData?.nodes["step-writer-1"]?.messages.map((message) => message.id),
    ).toEqual(["assistant-writer-1"]);
    expect(
      traceData?.nodes["step-writer-2"]?.messages.map((message) => message.id),
    ).toEqual(["assistant-writer-2"]);
  });

});
