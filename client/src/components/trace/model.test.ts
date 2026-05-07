import { describe, expect, it } from "vitest";
import { AG_UI_TRACE_EVENT_NAME } from "ag-ui-react";
import type { ActiveStep, ChatMessage, TraceEvent } from "ag-ui-react";

import {
  buildAgentTraceData,
  buildTimelineTraceEntries,
  buildTurnPresentation,
  filterTraceEventsForTurn,
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
    stepId: parentStepName ? `step-${stepName}-1` : `step-${stepName}-root`,
    ...(parentStepName ? { parentStepId: `step-${parentStepName}-root` } : {}),
    ...(parentStepName ? { stepKind: "subagent" } : { stepKind: "supervisor" }),
    stepName,
    ...(parentStepName ? { parentStepName } : {}),
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
            stepName: "assistant",
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
            stepName: "supervisor",
          },
        ],
      },
      {
        ...assistantMessage(
          "assistant-2",
          "The result is 1057.33...",
          "writer",
        ),
        stepId: "step-writer-1",
        parentStepId: "step-supervisor-root",
        stepKind: "subagent",
        parentStepName: "supervisor",
      },
    ];
    const activeSteps: ActiveStep[] = [
      {
        stepId: "step-supervisor-root",
        stepName: "supervisor",
        stepKind: "supervisor",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        stepId: "step-writer-1",
        parentStepId: "step-supervisor-root",
        stepKind: "subagent",
        stepName: "writer",
        parentStepName: "supervisor",
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
        stepId: "step-node-1",
        stepKind: "node",
      },
      {
        id: "tool-1",
        role: "tool",
        content: "Successfully transferred to writer",
        toolCallId: "transfer-1",
        stepId: "step-tools-1",
        stepKind: "node",
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      {
        ...assistantMessage("assistant-2", "Final answer from some node."),
        stepId: "step-node-2",
        stepKind: "node",
      },
    ];

    expect(getTraceMode(messages, [])).toBe("timeline");
    expect(buildAgentTraceData(messages, [])).toBeNull();
  });

  it("builds a stepId-based tree from trace events without merging same-name sub-agents", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-1", "Draft one", "writer"),
        stepId: "step-writer-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        parentStepName: "supervisor",
      },
      {
        ...assistantMessage("assistant-writer-2", "Draft two", "writer"),
        stepId: "step-writer-2",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        parentStepName: "supervisor",
      },
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepKind: "supervisor",
        stepName: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "writer",
        parentStepName: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-2",
        parentStepId: "step-supervisor-1",
        stepKind: "subagent",
        stepName: "writer",
        parentStepName: "supervisor",
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);

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

  it("builds an agent tree from canonical ag-ui.trace span and link events", () => {
    const messages: ChatMessage[] = [
      assistantMessage("assistant-supervisor", "Routing to writer"),
      {
        ...assistantMessage("assistant-writer", "Draft from writer"),
        toolCalls: [
          {
            id: "tool-calc",
            type: "function",
            function: {
              name: "calculate",
              arguments: '{"expression":"2+2"}',
            },
            complete: true,
          },
        ],
      },
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-supervisor-1",
          name: "supervisor",
          kind: "supervisor",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-supervisor",
          spanId: "span-supervisor-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-writer-1",
          name: "writer",
          kind: "subagent",
          parentSpanId: "span-supervisor-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-writer",
          spanId: "span-writer-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "tool.link",
          toolCallId: "tool-calc",
          spanId: "span-writer-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.end",
          spanId: "span-writer-1",
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);

    expect(getTraceMode(messages, [], traceEvents)).toBe("agent");
    expect(traceData?.roots).toEqual(["span-supervisor-1"]);
    expect(traceData?.nodes["span-supervisor-1"]?.childStepIds).toEqual([
      "span-writer-1",
    ]);
    expect(
      traceData?.nodes["span-writer-1"]?.messages.map((message) => message.id),
    ).toEqual(["assistant-writer"]);
    expect(traceData?.nodes["span-writer-1"]?.active).toBe(false);
  });

  it("does not merge canonical child agents that share an instance id but have different types", () => {
    const messages: ChatMessage[] = [
      assistantMessage("assistant-supervisor", "Routing research"),
      assistantMessage("assistant-weather", "Weather findings"),
      assistantMessage("assistant-guidance", "Packing guidance"),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-supervisor-1",
          name: "supervisor",
          kind: "supervisor",
          owner: {
            key: "run-1:supervisor:supervisor:root",
            type: "supervisor",
            instanceId: "supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "message.link",
          messageId: "assistant-supervisor",
          spanId: "span-supervisor-1",
          owner: {
            key: "run-1:supervisor:supervisor:root",
            type: "supervisor",
            instanceId: "supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-weather-1",
          name: "weather_researcher",
          kind: "subagent",
          parentSpanId: "span-supervisor-1",
          owner: {
            key: "run-1:weather_researcher:agent:shared",
            type: "weather_researcher",
            instanceId: "agent:shared",
            parentKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "message.link",
          messageId: "assistant-weather",
          spanId: "span-weather-1",
          owner: {
            key: "run-1:weather_researcher:agent:shared",
            type: "weather_researcher",
            instanceId: "agent:shared",
            parentKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-guidance-1",
          name: "travel_guidance_researcher",
          kind: "subagent",
          parentSpanId: "span-supervisor-1",
          owner: {
            key: "run-1:travel_guidance_researcher:agent:shared",
            type: "travel_guidance_researcher",
            instanceId: "agent:shared",
            parentKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "message.link",
          messageId: "assistant-guidance",
          spanId: "span-guidance-1",
          owner: {
            key: "run-1:travel_guidance_researcher:agent:shared",
            type: "travel_guidance_researcher",
            instanceId: "agent:shared",
            parentKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);

    expect(traceData?.roots).toEqual(["supervisor:supervisor:root"]);
    expect(traceData?.nodes["supervisor:supervisor:root"]?.childStepIds).toEqual(
      [
        "weather_researcher:agent:shared",
        "travel_guidance_researcher:agent:shared",
      ],
    );
    expect(
      traceData?.nodes["weather_researcher:agent:shared"]?.messages.map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-weather"]);
    expect(
      traceData?.nodes["travel_guidance_researcher:agent:shared"]?.messages.map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-guidance"]);
  });

  it("merges canonical sub-agent spans that share the same checkpoint namespace root", () => {
    const messages: ChatMessage[] = [
      assistantMessage("assistant-supervisor-1", "Route to writer"),
      assistantMessage("assistant-writer-1", "Writer planning"),
      assistantMessage("assistant-supervisor-2", "Retrying after tool failure"),
      assistantMessage("assistant-writer-2", "Writer final output"),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-supervisor-1",
          name: "supervisor",
          kind: "supervisor",
          source: {
            checkpointNamespace: "supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-supervisor-1",
          spanId: "span-supervisor-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-writer-physical-1",
          name: "writer",
          kind: "subagent",
          parentSpanId: "span-supervisor-1",
          source: {
            checkpointNamespace: "writer:subgraph-1|agent:1",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-writer-1",
          spanId: "span-writer-physical-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.end",
          spanId: "span-writer-physical-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-supervisor-2",
          name: "supervisor",
          kind: "supervisor",
          source: {
            checkpointNamespace: "supervisor:retry",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-supervisor-2",
          spanId: "span-supervisor-2",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-writer-physical-2",
          name: "writer",
          kind: "subagent",
          parentSpanId: "span-supervisor-2",
          source: {
            checkpointNamespace: "writer:subgraph-1|agent:2",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "message.link",
          messageId: "assistant-writer-2",
          spanId: "span-writer-physical-2",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.end",
          spanId: "span-writer-physical-2",
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);

    expect(traceData?.nodes["span-supervisor-1"]?.childStepIds).toEqual([
      "span-writer-physical-1",
    ]);
    expect(
      traceData?.nodes["span-writer-physical-1"]?.messages.map(
        (message) => message.id,
      ),
    ).toEqual(["assistant-writer-1", "assistant-writer-2"]);
    expect(traceData?.nodes["span-writer-physical-2"]).toBeUndefined();
  });

  it("keeps multiple canonical roots in their first trace order", () => {
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-writer-1",
          name: "writer",
          kind: "subagent",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-supervisor-1",
          name: "supervisor",
          kind: "supervisor",
        },
      },
    ];

    const traceData = buildAgentTraceData([], [], traceEvents);

    expect(traceData?.roots).toEqual(["span-writer-1", "span-supervisor-1"]);
  });

  it("keeps same-name canonical sub-agents separate when ownerKey differs", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-alpha", "Alpha draft", "writer"),
        ownerKey: "run-1:writer:writer:alpha",
        agentType: "writer",
        instanceId: "writer:alpha",
      },
      {
        ...assistantMessage("assistant-writer-beta", "Beta draft", "writer"),
        ownerKey: "run-1:writer:writer:beta",
        agentType: "writer",
        instanceId: "writer:beta",
      },
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-supervisor",
          name: "supervisor",
          kind: "supervisor",
          owner: {
            ownerKey: "run-1:supervisor:supervisor:root",
            agentType: "supervisor",
            instanceId: "supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-writer-alpha",
          name: "writer",
          kind: "subagent",
          parentSpanId: "span-supervisor",
          owner: {
            ownerKey: "run-1:writer:writer:alpha",
            agentType: "writer",
            instanceId: "writer:alpha",
            parentOwnerKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          spanId: "span-writer-beta",
          name: "writer",
          kind: "subagent",
          parentSpanId: "span-supervisor",
          owner: {
            ownerKey: "run-1:writer:writer:beta",
            agentType: "writer",
            instanceId: "writer:beta",
            parentOwnerKey: "run-1:supervisor:supervisor:root",
          },
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "message.link",
          messageId: "assistant-writer-alpha",
          spanId: "span-writer-alpha",
          ownerKey: "run-1:writer:writer:alpha",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "message.link",
          messageId: "assistant-writer-beta",
          spanId: "span-writer-beta",
          ownerKey: "run-1:writer:writer:beta",
        },
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);

    expect(traceData?.nodes["run-1:writer:writer:alpha"]?.messages.map((message) => message.id))
      .toEqual(["assistant-writer-alpha"]);
    expect(traceData?.nodes["run-1:writer:writer:beta"]?.messages.map((message) => message.id))
      .toEqual(["assistant-writer-beta"]);
  });

  it("keeps only latest unlinked canonical lifecycle events for an empty live turn", () => {
    const traceEvents: TraceEvent[] = [
      { type: "RUN_STARTED", runId: "run-old" },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-old",
          name: "supervisor",
          kind: "supervisor",
        },
      },
      { type: "RUN_FINISHED", runId: "run-old" },
      { type: "RUN_STARTED", runId: "run-new" },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 1,
          type: "span.start",
          spanId: "span-new",
          name: "supervisor",
          kind: "supervisor",
        },
      },
    ];

    expect(filterTraceEventsForTurn(traceEvents, [], true)).toEqual([
      traceEvents[4],
    ]);
  });
});
