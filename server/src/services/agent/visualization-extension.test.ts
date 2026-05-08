import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import { createDemoVisualizationExtension } from "./visualization-extension.js";

describe("createDemoVisualizationExtension", () => {
  it("ignores internal tools namespaces and keeps tool activity on the parent agent", () => {
    const extension = createDemoVisualizationExtension();
    const event = {
      type: EventType.TOOL_CALL_START,
      toolCallId: "tool-1",
      toolCallName: "search_web",
      parentMessageId: "msg-1",
      messageId: "msg-1",
    } as BaseEvent & {
      toolCallId: string;
      toolCallName: string;
      parentMessageId: string;
      messageId: string;
      extra?: Record<string, unknown>;
    };

    extension.beforeDispatchEvent?.(event, {
      agentName: "supervisor",
      activeRun: null,
      currentSubgraph: "__root__",
      subgraphs: new Set<string>(),
      langgraph: {
        nodeName: "tools",
        checkpointNamespace: "supervisor:root|writer:one|tools:tools",
      },
    });

    expect(event.extra?.visualization).toEqual({
      owner: {
        key: "writer:one",
        type: "writer",
        instanceId: "one",
        parentKey: "supervisor:root",
      },
      step: {
        id: "writer:one",
        parentId: "supervisor:root",
        kind: "subagent",
        name: "writer",
      },
    });
  });
});
