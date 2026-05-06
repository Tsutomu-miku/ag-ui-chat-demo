import { describe, expect, it } from "vitest";
import { AG_UI_TRACE_EVENT_NAME } from "ag-ui-react";
import type { ChatMessage, TraceEvent } from "ag-ui-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentTraceView,
  buildAgentRenderItems,
  getTraceMessageBadge,
} from "./AgentTraceView";
import { buildAgentTraceData } from "./model";
import { TimelineTraceView } from "./TimelineTraceView";

function assistantMessage(
  id: string,
  content: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id,
    role: "assistant",
    content,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AgentTraceView ordering", () => {
  it("renders sub-agent activity between supervisor handoff and supervisor summary", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer", {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        }),
        toolCalls: [
          {
            id: "tool-transfer-1",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"calculate and explain"}',
            },
            complete: true,
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Working on the calculation", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
      assistantMessage("assistant-supervisor-2", "Perfect! I've completed your request.", {
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const supervisor = traceData?.nodes["step-supervisor-1"];

    expect(traceData).not.toBeNull();
    expect(supervisor).toBeDefined();

    const renderItems = buildAgentRenderItems(
      supervisor!,
      supervisor!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "message"
          ? item.message.id
          : item.type === "tool"
            ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
          : `child:${item.stepId}:${item.input ?? "no-input"}`,
      ),
    ).toEqual([
      "assistant-supervisor-1",
      'child:step-writer-1:{"task":"calculate and explain"}',
      "assistant-supervisor-2",
    ]);
  });

  it("keeps multiple sub-agents anchored to their own handoff messages", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer", {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        }),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"draft"}',
            },
            complete: true,
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
      {
        ...assistantMessage("assistant-supervisor-2", "Routing to researcher", {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        }),
        toolCalls: [
          {
            id: "tool-transfer-researcher",
            type: "function",
            function: {
              name: "transfer_to_researcher",
              arguments: '{"task":"verify"}',
            },
            complete: true,
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ],
      },
      assistantMessage("assistant-researcher-1", "Researcher output", {
        stepId: "step-researcher-1",
        stepName: "researcher",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
      assistantMessage("assistant-supervisor-3", "Perfect! I've completed your request.", {
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-researcher-1",
        stepName: "researcher",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const supervisor = traceData?.nodes["step-supervisor-1"];

    const renderItems = buildAgentRenderItems(
      supervisor!,
      supervisor!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "message"
          ? item.message.id
          : item.type === "tool"
            ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
          : `child:${item.stepId}:${item.input ?? "no-input"}`,
      ),
    ).toEqual([
      "assistant-supervisor-1",
      'child:step-writer-1:{"task":"draft"}',
      "assistant-supervisor-2",
      'child:step-researcher-1:{"task":"verify"}',
      "assistant-supervisor-3",
    ]);
  });

  it("renders canonical tool links even when only a tool result message is linked", () => {
    const messages: ChatMessage[] = [
      {
        id: "tool-result-1",
        role: "tool",
        content: '{"ok":true}',
        toolCallId: "tool-search-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: "ag-ui.trace",
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-researcher-1",
          agentName: "researcher",
          kind: "subagent",
          parentAgentId: "agent-supervisor-1",
        },
      },
      {
        type: "TOOL_CALL_RESULT",
        toolCallId: "tool-search-1",
        toolCallName: "search_web",
        messageId: "tool-result-1",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      } as TraceEvent & { agentId: string; agentName: string },
    ];
    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const researcher = traceData?.nodes["agent-researcher-1"];

    const renderItems = buildAgentRenderItems(
      researcher!,
      researcher!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "tool"
          ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
          : item.type === "message"
            ? item.message.id
            : `child:${item.stepId}`,
      ),
    ).toEqual(["tool:tool-search-1:search_web"]);
  });

  it("does not infer delegated child input from plain transfer text", () => {
    const messages: ChatMessage[] = [
      assistantMessage(
        "assistant-supervisor-1",
        "I'll transfer this request to the writer agent.",
        {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        },
      ),
      assistantMessage("assistant-writer-1", "Writer output", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const supervisor = traceData?.nodes["step-supervisor-1"];
    const renderItems = buildAgentRenderItems(
      supervisor!,
      supervisor!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "child"
          ? `child:${item.stepId}:${item.input ?? "no-input"}`
          : item.type === "message"
            ? item.message.id
            : `tool:${item.toolCall.id}`,
      ),
    ).toEqual(["assistant-supervisor-1", "child:step-writer-1:no-input"]);
  });

  it("shows explicit handoff input inside the child agent block", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer", {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        }),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"input":"Calculate (23 * 45) + (67 / 3) and explain it."}',
            },
            complete: true,
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Working on the calculation", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        traceEvents,
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("Calculate (23 * 45) + (67 / 3) and explain it.");
    expect(markup).not.toContain("&quot;input&quot;");
  });

  it("interleaves canonical parent execution, sub-agent work, and parent summary", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer"),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"draft"}',
            },
            complete: true,
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output"),
      assistantMessage(
        "assistant-supervisor-2",
        "Perfect! I've completed your request.",
      ),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-supervisor-1",
          agentName: "supervisor",
          kind: "supervisor",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tool-transfer-writer",
        toolCallName: "transfer_to_writer",
        parentMessageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-writer-1",
          agentName: "writer",
          kind: "subagent",
          parentAgentId: "agent-supervisor-1",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-writer-1",
        agentId: "agent-writer-1",
        agentName: "writer",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-supervisor-2",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
    ];
    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const supervisor = traceData?.nodes["agent-supervisor-1"];

    const renderItems = buildAgentRenderItems(
      supervisor!,
      supervisor!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "message"
          ? item.message.id
          : item.type === "tool"
            ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
            : `child:${item.stepId}:${item.input ?? "no-input"}`,
      ),
    ).toEqual([
      "assistant-supervisor-1",
      'child:agent-writer-1:{"task":"draft"}',
      "assistant-supervisor-2",
    ]);
  });

  it("does not render a delegated handoff tool twice when it anchors a child agent", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer"),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"draft"}',
            },
            complete: true,
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output"),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-supervisor-1",
          agentName: "supervisor",
          kind: "supervisor",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tool-transfer-writer",
        toolCallName: "transfer_to_writer",
        parentMessageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-writer-1",
          agentName: "writer",
          kind: "subagent",
          parentAgentId: "agent-supervisor-1",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-writer-1",
        agentId: "agent-writer-1",
        agentName: "writer",
      } as TraceEvent & { agentId: string; agentName: string },
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        traceEvents,
        toolResultById: new Map(),
      }),
    );

    expect(markup).not.toContain("Handoff -&gt; Writer");
    expect(markup).toContain("Writer output");
    expect(markup).toContain("&quot;task&quot;: &quot;draft&quot;");
  });

  it("renders explicit hierarchy labels for root and child agents", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer", {
          stepId: "step-supervisor-1",
          stepName: "supervisor",
          stepKind: "supervisor",
        }),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"draft"}',
            },
            complete: true,
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        traceEvents,
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("Root agent");
    expect(markup).toContain("Sub-agent of Supervisor");
    expect(markup).toContain("Supervisor -&gt; Writer");
    expect(markup).not.toContain("Delegated branch");
  });

  it("merges supervisor continuation entries into the same parent sequence", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer"),
        toolCalls: [
          {
            id: "tool-transfer-writer",
            type: "function",
            function: {
              name: "transfer_to_writer",
              arguments: '{"task":"draft"}',
            },
            complete: true,
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output"),
      assistantMessage(
        "assistant-supervisor-2",
        "Supervisor received the writer response.",
      ),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-supervisor-1",
          agentName: "supervisor",
          kind: "supervisor",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tool-transfer-writer",
        toolCallName: "transfer_to_writer",
        parentMessageId: "assistant-supervisor-1",
        agentId: "agent-supervisor-1",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.end",
          agentId: "agent-supervisor-1",
        },
      },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-writer-1",
          agentName: "writer",
          kind: "subagent",
          parentAgentId: "agent-supervisor-1",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-writer-1",
        agentId: "agent-writer-1",
        agentName: "writer",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-supervisor-2",
          agentName: "supervisor",
          kind: "supervisor",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-supervisor-2",
        agentId: "agent-supervisor-2",
        agentName: "supervisor",
      } as TraceEvent & { agentId: string; agentName: string },
    ];
    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const supervisor = traceData?.nodes["agent-supervisor-1"];

    expect(traceData?.roots).toEqual(["agent-supervisor-1"]);

    const renderItems = buildAgentRenderItems(
      supervisor!,
      supervisor!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "message"
          ? item.message.id
          : item.type === "tool"
            ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
            : `child:${item.stepId}:${item.input ?? "no-input"}`,
      ),
    ).toEqual([
      "assistant-supervisor-1",
      'child:agent-writer-1:{"task":"draft"}',
      "assistant-supervisor-2",
    ]);
  });

  it("keeps canonical orphan tools at their trace position instead of appending them", () => {
    const messages: ChatMessage[] = [
      assistantMessage("assistant-researcher-1", "Searching first."),
      {
        id: "tool-result-1",
        role: "tool",
        content: '{"items":["result"]}',
        toolCallId: "tool-search-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      assistantMessage("assistant-researcher-2", "Search summary."),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "CUSTOM",
        name: AG_UI_TRACE_EVENT_NAME,
        value: {
          version: 2,
          type: "span.start",
          agentId: "agent-researcher-1",
          agentName: "researcher",
          kind: "subagent",
        },
      },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-researcher-1",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TOOL_CALL_START",
        toolCallId: "tool-search-1",
        toolCallName: "search_web",
        parentMessageId: "assistant-researcher-1",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      } as TraceEvent & { agentId: string; agentName: string },
      {
        type: "TEXT_MESSAGE_START",
        messageId: "assistant-researcher-2",
        agentId: "agent-researcher-1",
        agentName: "researcher",
      } as TraceEvent & { agentId: string; agentName: string },
    ];
    const traceData = buildAgentTraceData(messages, [], traceEvents);
    const researcher = traceData?.nodes["agent-researcher-1"];

    const renderItems = buildAgentRenderItems(
      researcher!,
      researcher!.childStepIds,
      traceData!,
    );

    expect(
      renderItems.map((item) =>
        item.type === "message"
          ? item.message.id
          : item.type === "tool"
            ? `tool:${item.toolCall.id}:${item.toolCall.function.name}`
            : `child:${item.stepId}`,
      ),
    ).toEqual([
      "assistant-researcher-1",
      "tool:tool-search-1:search_web",
      "assistant-researcher-2",
    ]);
  });

  it("renders streaming tool args progressively in the agent trace view", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-1", "Searching...", {
          stepId: "step-writer-1",
          stepName: "writer",
          stepKind: "subagent",
          parentStepId: "step-supervisor-1",
          parentStepName: "supervisor",
          isStreaming: true,
        }),
        toolCalls: [
          {
            id: "tool-search-1",
            type: "function",
            function: {
              name: "search_web",
              arguments: '{"query":"hel',
            },
            complete: false,
          },
        ],
      },
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        traceEvents,
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("Input streaming");
    expect(markup).toContain("{&quot;query&quot;:&quot;hel");
    expect(markup).toContain("▊");
  });

  it("renders completed tool args as formatted json in the timeline trace view", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "Let me search."),
        toolCalls: [
          {
            id: "tool-search-1",
            type: "function",
            function: {
              name: "search_web",
              arguments: '{"query":"hello"}',
            },
            complete: true,
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(TimelineTraceView, {
        messages,
        activeSteps: [],
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("Input");
    expect(markup).toContain("{\n  &quot;query&quot;: &quot;hello&quot;\n}");
    expect(markup).not.toContain("Input streaming");
  });

  it("renders streaming tool output progressively in the timeline trace view", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "Running calculation."),
        toolCalls: [
          {
            id: "tool-calc-1",
            type: "function",
            function: {
              name: "calculate",
              arguments: '{"expression":"2+2"}',
            },
            complete: false,
          },
        ],
      },
      {
        id: "tool-result-1",
        role: "tool",
        content: '{"res',
        toolCallId: "tool-calc-1",
        isStreaming: true,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(TimelineTraceView, {
        messages,
        activeSteps: [],
        toolResultById: new Map([
          [
            "tool-calc-1",
            {
              content: '{"res',
              isStreaming: true,
            },
          ],
        ]),
      }),
    );

    expect(markup).toContain("Output streaming");
    expect(markup).toContain("{&quot;res");
    expect(markup).toContain("▊");
  });

  it("keeps request badge hidden while preserving output and summary badges", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage(
          "assistant-supervisor-1",
          "I'll transfer this to the writer agent.",
          {
            stepId: "step-supervisor-1",
            stepName: "supervisor",
            stepKind: "supervisor",
          },
        ),
      },
      assistantMessage("assistant-writer-1", "Draft complete.", {
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      }),
      assistantMessage("assistant-supervisor-2", "Perfect! I've completed your request.", {
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      }),
    ];
    const traceEvents: TraceEvent[] = [
      {
        type: "STEP_STARTED",
        stepId: "step-supervisor-1",
        stepName: "supervisor",
        stepKind: "supervisor",
      },
      {
        type: "STEP_STARTED",
        stepId: "step-writer-1",
        stepName: "writer",
        stepKind: "subagent",
        parentStepId: "step-supervisor-1",
        parentStepName: "supervisor",
      },
    ];
    const traceData = buildAgentTraceData(messages, [], traceEvents);

    expect(
      getTraceMessageBadge(messages[0]!, traceData!, false, false),
    ).toBeUndefined();
    expect(
      getTraceMessageBadge(messages[1]!, traceData!, true, true),
    ).toBe("Sub-agent output");
    expect(
      getTraceMessageBadge(messages[2]!, traceData!, false, true),
    ).toBe("Supervisor summary");
  });
});
