import type { Message, ToolCall } from "@ag-ui/core";
import { describe, expect, it } from "vitest";

import {
  collectAssistantToolCallIds,
  isDuplicateAssistantToolCall,
  messageContentToString,
} from "./message-utils.js";

function createToolCall(id: string): ToolCall {
  return {
    id,
    type: "function",
    function: {
      name: "search_web",
      arguments: '{"query":"hello"}',
    },
  };
}

describe("message-utils", () => {
  it("converts structured message content into plain text", () => {
    expect(
      messageContentToString([
        { type: "text", text: "hello" },
        { type: "image", image_url: "https://example.com/image.png" },
      ] as Message["content"]),
    ).toBe("hello\n[image]");
  });

  it("collects assistant tool call ids only from assistant messages", () => {
    const target = new Set<string>();

    collectAssistantToolCallIds(
      {
        role: "assistant",
        toolCalls: [createToolCall("tool-1"), createToolCall("tool-2")],
      },
      target,
    );
    collectAssistantToolCallIds(
      {
        role: "user",
        toolCalls: [createToolCall("ignored-tool")],
      },
      target,
    );

    expect(Array.from(target)).toEqual(["tool-1", "tool-2"]);
  });

  it("detects duplicate assistant tool calls only when content is empty", () => {
    const knownToolCallIds = new Set(["tool-1"]);

    expect(
      isDuplicateAssistantToolCall(
        {
          role: "assistant",
          content: "",
          toolCalls: [createToolCall("tool-1")],
        },
        knownToolCallIds,
      ),
    ).toBe(true);

    expect(
      isDuplicateAssistantToolCall(
        {
          role: "assistant",
          content: "I am thinking...",
          toolCalls: [createToolCall("tool-1")],
        },
        knownToolCallIds,
      ),
    ).toBe(false);

    expect(
      isDuplicateAssistantToolCall(
        {
          role: "assistant",
          content: "",
          toolCalls: [createToolCall("tool-2")],
        },
        knownToolCallIds,
      ),
    ).toBe(false);
  });
});
