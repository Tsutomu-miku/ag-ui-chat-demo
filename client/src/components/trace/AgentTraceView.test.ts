import { describe, expect, it } from "vitest";
import type { ChatMessage, EventExtra } from "ag-ui-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AgentTraceView,
  buildAgentRenderItems,
  getTraceMessageBadge,
} from "./AgentTraceView";
import { buildAgentTraceData } from "./model";
import { TimelineTraceView } from "./TimelineTraceView";

function visualizationExtra(opts: {
  id: string;
  name: string;
  parentId?: string;
  kind?: string;
}): EventExtra {
  return {
    visualization: {
      step: {
        id: opts.id,
        name: opts.name,
        ...(opts.parentId ? { parentId: opts.parentId } : {}),
        kind: opts.kind ?? (opts.parentId ? "subagent" : "agent"),
      },
      owner: {
        key: opts.id,
        type: opts.name,
        instanceId: opts.id.split(":").at(-1) ?? opts.id,
        ...(opts.parentId ? { parentKey: opts.parentId } : {}),
      },
    },
  };
}

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
  it("renders sub-agent activity between supervisor handoff and summary", () => {
    const supervisorExtra = visualizationExtra({
      id: "supervisor:root",
      name: "supervisor",
    });
    const writerExtra = visualizationExtra({
      id: "writer:one",
      name: "writer",
      parentId: "supervisor:root",
    });
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-supervisor-1", "Routing to writer", {
          extra: supervisorExtra,
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
            extra: supervisorExtra,
          },
        ],
      },
      assistantMessage("assistant-writer-1", "Writer output", {
        extra: writerExtra,
      }),
      assistantMessage(
        "assistant-supervisor-2",
        "Perfect! I've completed your request.",
        { extra: supervisorExtra },
      ),
    ];

    const traceData = buildAgentTraceData(messages, [], []);
    const supervisor = traceData?.nodes["supervisor:root"];
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
      'child:writer:one:{"task":"draft"}',
      "assistant-supervisor-2",
    ]);
  });

  it("renders hierarchy labels from extra.visualization", () => {
    const supervisorExtra = visualizationExtra({
      id: "supervisor:root",
      name: "supervisor",
    });
    const writerExtra = visualizationExtra({
      id: "writer:one",
      name: "writer",
      parentId: "supervisor:root",
    });
    const messages: ChatMessage[] = [
      assistantMessage("assistant-supervisor-1", "Routing", {
        extra: supervisorExtra,
      }),
      assistantMessage("assistant-writer-1", "Writer output", {
        extra: writerExtra,
      }),
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        events: [],
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("Root agent");
    expect(markup).toContain("Sub-agent of Supervisor");
    expect(markup).toContain("Writer output");
  });

  it("renders streaming tool args progressively in the agent trace view", () => {
    const writerExtra = visualizationExtra({
      id: "writer:one",
      name: "writer",
      parentId: "supervisor:root",
    });
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-writer-1", "Searching...", {
          extra: writerExtra,
          isStreaming: true,
        }),
        toolCalls: [
          {
            id: "tool-search-1",
            type: "function",
            function: {
              name: "search_web",
              arguments: '{"query":"weather',
            },
            complete: false,
            extra: writerExtra,
          },
        ],
      },
    ];

    const markup = renderToStaticMarkup(
      createElement(AgentTraceView, {
        messages,
        activeSteps: [],
        events: [],
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("{&quot;query&quot;:&quot;weather");
    expect(markup).toContain("cursor-blink");
  });

  it("renders completed tool args as formatted json in the timeline trace view", () => {
    const messages: ChatMessage[] = [
      {
        ...assistantMessage("assistant-1", "Calculating"),
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
    ];

    const markup = renderToStaticMarkup(
      createElement(TimelineTraceView, {
        messages,
        activeSteps: [],
        toolResultById: new Map(),
      }),
    );

    expect(markup).toContain("expression");
    expect(markup).toContain("2+2");
  });

  it("keeps request badge hidden while preserving output and summary badges", () => {
    const supervisorExtra = visualizationExtra({
      id: "supervisor:root",
      name: "supervisor",
    });
    const writerExtra = visualizationExtra({
      id: "writer:one",
      name: "writer",
      parentId: "supervisor:root",
    });
    const messages: ChatMessage[] = [
      assistantMessage("writer-progress", "Working on it", {
        extra: writerExtra,
      }),
      assistantMessage("writer-output", "Final draft", {
        extra: writerExtra,
      }),
      assistantMessage("supervisor-summary", "Perfect! I've completed it.", {
        extra: supervisorExtra,
      }),
    ];
    const traceData = buildAgentTraceData(messages, [], [])!;

    expect(
      getTraceMessageBadge(messages[0]!, traceData, true, false),
    ).toBe("Sub-agent progress");
    expect(
      getTraceMessageBadge(messages[1]!, traceData, false, true),
    ).toBe("Sub-agent output");
    expect(
      getTraceMessageBadge(messages[2]!, traceData, false, true),
    ).toBe("Supervisor summary");
  });
});
