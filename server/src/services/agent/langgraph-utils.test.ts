import type { Message, Tool } from "@ag-ui/core";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  asArray,
  contentToString,
  frontendToolToModelTool,
  getToolCalls,
  parseToolArgs,
  toLangChainMessages,
} from "./langgraph-utils.js";

describe("langgraph-utils", () => {
  it("converts structured content into plain text", () => {
    expect(
      contentToString([
        { type: "text", text: "hello" },
        { type: "image", image_url: "https://example.com/image.png" },
      ] as Message["content"]),
    ).toBe("hello\n[image]");
  });

  it("returns an empty object when tool args are invalid JSON", () => {
    expect(parseToolArgs('{"broken":')).toEqual({});
  });

  it("maps AG-UI messages to LangChain messages", () => {
    const messages = toLangChainMessages([
      {
        id: "user-1",
        role: "user",
        content: "hello",
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            type: "function",
            function: {
              name: "search_web",
              arguments: '{"query":"hello"}',
            },
          },
        ],
      },
      {
        id: "tool-msg-1",
        role: "tool",
        content: '{"results":[]}',
        toolCallId: "tool-1",
      },
    ]);

    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[1]).toBeInstanceOf(AIMessage);
    expect(messages[2]).toBeInstanceOf(ToolMessage);
    expect((messages[1] as AIMessage).tool_calls).toMatchObject([
      {
        id: "tool-1",
        name: "search_web",
        args: { query: "hello" },
      },
    ]);
  });

  it("converts frontend tools into model tool definitions", () => {
    const tool: Tool = {
      name: "confirm_action",
      description: "Confirm an action",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string" },
        },
      },
    };

    expect(frontendToolToModelTool(tool)).toEqual({
      type: "function",
      function: {
        name: "confirm_action",
        description: "Confirm an action",
        parameters: {
          type: "object",
          properties: {
            action: { type: "string" },
          },
        },
      },
    });
  });

  it("returns tool calls only for AI messages", () => {
    const aiMessage = new AIMessage({
      content: "",
      tool_calls: [
        {
          id: "tool-1",
          name: "calculate",
          args: { expression: "2+2" },
          type: "tool_call",
        },
      ],
    });

    expect(getToolCalls(aiMessage)).toEqual([
      {
        id: "tool-1",
        name: "calculate",
        args: { expression: "2+2" },
      },
    ]);
    expect(getToolCalls(new HumanMessage("hello"))).toEqual([]);
    expect(getToolCalls(undefined)).toEqual([]);
  });

  it("normalizes maybe-array values", () => {
    expect(asArray(undefined)).toEqual([]);
    expect(asArray("value")).toEqual(["value"]);
    expect(asArray(["a", "b"])).toEqual(["a", "b"]);
  });
});
