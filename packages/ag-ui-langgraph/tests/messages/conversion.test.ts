/**
 * Tests for convert.ts — message conversion utilities.
 * Aligned with Python test coverage for utils.py.
 */

import type { Message, Tool } from "@ag-ui/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  contentToString,
  parseToolArgs,
  stringifyIfNeeded,
  toLangChainMessages,
  aguiMessagesToLangchain,
  langchainMessagesToAgui,
  frontendToolToModelTool,
  getToolCalls,
  asArray,
  convertLangchainMultimodalToAgui,
  convertAguiMultimodalToLangchain,
  resolveMessageContent,
  flattenUserContent,
  normalizeToolContent,
  camelToSnake,
} from "../../src/messages/convert.js";

// ============================================================
// contentToString
// ============================================================

describe("contentToString", () => {
  it("returns empty string for undefined", () => {
    expect(contentToString(undefined)).toBe("");
  });

  it("returns empty string for null", () => {
    expect(contentToString(null as unknown as string)).toBe("");
  });

  it("passes through plain strings", () => {
    expect(contentToString("hello world")).toBe("hello world");
  });

  it("extracts text from structured content blocks", () => {
    expect(
      contentToString([
        { type: "text", text: "hello" },
        { type: "image", image_url: "https://example.com/image.png" },
      ] as Message["content"]),
    ).toBe("hello\n[image]");
  });

  it("handles mixed content types", () => {
    expect(
      contentToString([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ] as Message["content"]),
    ).toBe("first\nsecond");
  });

  it("handles empty arrays", () => {
    expect(contentToString([] as unknown as string)).toBe("");
  });
});

// ============================================================
// parseToolArgs
// ============================================================

describe("parseToolArgs", () => {
  it("parses valid JSON", () => {
    expect(parseToolArgs('{"key":"value"}')).toEqual({ key: "value" });
  });

  it("returns empty object for invalid JSON", () => {
    expect(parseToolArgs('{"broken":')).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(parseToolArgs(undefined)).toEqual({});
  });

  it("returns empty object for empty string", () => {
    expect(parseToolArgs("")).toEqual({});
  });

  it("returns empty object for non-object JSON", () => {
    expect(parseToolArgs("[]")).toEqual({});
    expect(parseToolArgs('"value"')).toEqual({});
  });
});

// ============================================================
// stringifyIfNeeded
// ============================================================

describe("stringifyIfNeeded", () => {
  it("returns empty string for null", () => {
    expect(stringifyIfNeeded(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(stringifyIfNeeded(undefined)).toBe("");
  });

  it("passes through strings", () => {
    expect(stringifyIfNeeded("hello")).toBe("hello");
  });

  it("JSON-stringifies objects", () => {
    expect(stringifyIfNeeded({ key: "value" })).toBe('{"key":"value"}');
  });

  it("JSON-stringifies numbers", () => {
    expect(stringifyIfNeeded(42)).toBe("42");
  });
});

// ============================================================
// toLangChainMessages / aguiMessagesToLangchain
// ============================================================

describe("toLangChainMessages", () => {
  it("converts user messages", () => {
    const messages = toLangChainMessages([
      { id: "user-1", role: "user", content: "hello" },
    ]);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe("hello");
  });

  it("converts assistant messages with tool calls", () => {
    const messages = toLangChainMessages([
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
    ]);
    expect(messages[0]).toBeInstanceOf(AIMessage);
    expect((messages[0] as AIMessage).tool_calls).toMatchObject([
      { id: "tool-1", name: "search_web", args: { query: "hello" } },
    ]);
  });

  it("converts tool messages", () => {
    const messages = toLangChainMessages([
      {
        id: "tool-msg-1",
        role: "tool",
        content: '{"results":[]}',
        toolCallId: "tool-1",
      },
    ]);
    expect(messages[0]).toBeInstanceOf(ToolMessage);
    expect((messages[0] as ToolMessage).tool_call_id).toBe("tool-1");
  });

  it("converts system messages", () => {
    const messages = toLangChainMessages([
      { id: "sys-1", role: "system", content: "You are a helpful assistant" },
    ]);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
  });

  it("converts developer messages as system messages", () => {
    const messages = toLangChainMessages([
      { id: "dev-1", role: "developer", content: "System instruction" },
    ]);
    expect(messages[0]).toBeInstanceOf(SystemMessage);
  });

  it("converts full conversation thread", () => {
    const messages = toLangChainMessages([
      { id: "u1", role: "user", content: "hello" },
      {
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tc1",
            type: "function",
            function: { name: "search_web", arguments: '{"query":"hello"}' },
          },
        ],
      },
      {
        id: "t1",
        role: "tool",
        content: '{"results":[]}',
        toolCallId: "tc1",
      },
    ]);

    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[1]).toBeInstanceOf(AIMessage);
    expect(messages[2]).toBeInstanceOf(ToolMessage);
  });

  it("aguiMessagesToLangchain is an alias for toLangChainMessages", () => {
    const input = [
      { id: "u1", role: "user" as const, content: "test" },
    ];
    const result1 = toLangChainMessages(input);
    const result2 = aguiMessagesToLangchain(input);
    expect(result1[0].content).toEqual(result2[0].content);
  });
});

// ============================================================
// langchainMessagesToAgui
// ============================================================

describe("langchainMessagesToAgui", () => {
  it("converts HumanMessage to user", () => {
    const result = langchainMessagesToAgui([
      new HumanMessage({ id: "h1", content: "hi" }),
    ]);
    expect(result[0]).toMatchObject({
      id: "h1",
      role: "user",
      content: "hi",
    });
  });

  it("converts AIMessage to assistant", () => {
    const result = langchainMessagesToAgui([
      new AIMessage({ id: "a1", content: "reply" }),
    ]);
    expect(result[0]).toMatchObject({
      id: "a1",
      role: "assistant",
      content: "reply",
    });
  });

  it("converts AIMessage with tool calls", () => {
    const result = langchainMessagesToAgui([
      new AIMessage({
        id: "a1",
        content: "",
        tool_calls: [
          { id: "tc1", name: "calc", args: { expr: "2+2" }, type: "tool_call" },
        ],
      }),
    ]);
    expect(result[0]).toMatchObject({
      role: "assistant",
    });
    const msg = result[0] as { toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls![0].function.name).toBe("calc");
    expect(msg.toolCalls![0].function.arguments).toBe('{"expr":"2+2"}');
  });

  it("converts SystemMessage to system", () => {
    const result = langchainMessagesToAgui([
      new SystemMessage({ id: "s1", content: "be helpful" }),
    ]);
    expect(result[0]).toMatchObject({
      id: "s1",
      role: "system",
      content: "be helpful",
    });
  });

  it("converts ToolMessage to tool", () => {
    const result = langchainMessagesToAgui([
      new ToolMessage({ id: "t1", content: "42", tool_call_id: "tc1" }),
    ]);
    expect(result[0]).toMatchObject({
      id: "t1",
      role: "tool",
      content: "42",
    });
    expect((result[0] as { toolCallId?: string }).toolCallId).toBe("tc1");
  });

  it("round-trips messages", () => {
    const original = [
      new HumanMessage({ id: "h1", content: "hello" }),
      new AIMessage({ id: "a1", content: "hi there" }),
      new SystemMessage({ id: "s1", content: "be helpful" }),
    ];
    const agui = langchainMessagesToAgui(original);
    const roundTripped = toLangChainMessages(agui as Message[]);

    expect(roundTripped[0]).toBeInstanceOf(HumanMessage);
    expect(roundTripped[0].content).toBe("hello");
    expect(roundTripped[1]).toBeInstanceOf(AIMessage);
    expect(roundTripped[1].content).toBe("hi there");
    expect(roundTripped[2]).toBeInstanceOf(SystemMessage);
    expect(roundTripped[2].content).toBe("be helpful");
  });
});

// ============================================================
// frontendToolToModelTool
// ============================================================

describe("frontendToolToModelTool", () => {
  it("converts AG-UI tool to LangChain BindToolsInput", () => {
    const tool: Tool = {
      name: "confirm_action",
      description: "Confirm an action",
      parameters: {
        type: "object",
        properties: { action: { type: "string" } },
      },
    };

    expect(frontendToolToModelTool(tool)).toEqual({
      type: "function",
      function: {
        name: "confirm_action",
        description: "Confirm an action",
        parameters: {
          type: "object",
          properties: { action: { type: "string" } },
        },
      },
    });
  });

  it("uses default parameters when none provided", () => {
    const tool: Tool = {
      name: "my_tool",
      description: "desc",
    };

    const result = frontendToolToModelTool(tool);
    expect(result.function.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });
});

// ============================================================
// getToolCalls
// ============================================================

describe("getToolCalls", () => {
  it("extracts tool calls from AIMessage", () => {
    const msg = new AIMessage({
      content: "",
      tool_calls: [
        { id: "t1", name: "calc", args: { expr: "2+2" }, type: "tool_call" },
      ],
    });
    expect(getToolCalls(msg)).toEqual([
      { id: "t1", name: "calc", args: { expr: "2+2" } },
    ]);
  });

  it("returns empty for HumanMessage", () => {
    expect(getToolCalls(new HumanMessage("hi"))).toEqual([]);
  });

  it("returns empty for undefined", () => {
    expect(getToolCalls(undefined)).toEqual([]);
  });

  it("returns empty for AIMessage without tool calls", () => {
    expect(getToolCalls(new AIMessage("plain text"))).toEqual([]);
  });
});

// ============================================================
// asArray
// ============================================================

describe("asArray", () => {
  it("returns empty array for undefined", () => {
    expect(asArray(undefined)).toEqual([]);
  });

  it("wraps single value in array", () => {
    expect(asArray("val")).toEqual(["val"]);
  });

  it("passes through arrays", () => {
    expect(asArray(["a", "b"])).toEqual(["a", "b"]);
  });
});

// ============================================================
// camelToSnake
// ============================================================

describe("camelToSnake", () => {
  it("converts camelCase to snake_case", () => {
    expect(camelToSnake("helloWorld")).toBe("hello_world");
  });

  it("converts multi-hump camelCase", () => {
    expect(camelToSnake("myLongVariableName")).toBe("my_long_variable_name");
  });

  it("leaves snake_case unchanged", () => {
    expect(camelToSnake("already_snake")).toBe("already_snake");
  });

  it("handles single word", () => {
    expect(camelToSnake("hello")).toBe("hello");
  });
});

// ============================================================
// Multimodal conversion
// ============================================================

describe("convertLangchainMultimodalToAgui", () => {
  it("converts text blocks", () => {
    const result = convertLangchainMultimodalToAgui([
      { type: "text", text: "hello" },
    ]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts URL image blocks", () => {
    const result = convertLangchainMultimodalToAgui([
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ]);
    expect(result).toEqual([
      {
        type: "image",
        source: { type: "url", value: "https://example.com/img.png" },
      },
    ]);
  });

  it("converts data URL image blocks", () => {
    const result = convertLangchainMultimodalToAgui([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,/9j/4AAQ" },
      },
    ]);
    expect(result).toEqual([
      {
        type: "image",
        source: { type: "data", value: "/9j/4AAQ", mime_type: "image/jpeg" },
      },
    ]);
  });

  it("handles string image_url value", () => {
    const result = convertLangchainMultimodalToAgui([
      { type: "image_url", image_url: "https://example.com/img.png" },
    ]);
    expect(result).toEqual([
      {
        type: "image",
        source: { type: "url", value: "https://example.com/img.png" },
      },
    ]);
  });

  it("handles mixed content", () => {
    const result = convertLangchainMultimodalToAgui([
      { type: "text", text: "Look at this:" },
      { type: "image_url", image_url: { url: "https://example.com/img.png" } },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: "text", text: "Look at this:" });
    expect(result[1]).toMatchObject({ type: "image" });
  });
});

describe("convertAguiMultimodalToLangchain", () => {
  it("converts text items", () => {
    const result = convertAguiMultimodalToLangchain([
      { type: "text", text: "hello" },
    ]);
    expect(result).toEqual([{ type: "text", text: "hello" }]);
  });

  it("converts URL image items", () => {
    const result = convertAguiMultimodalToLangchain([
      {
        type: "image",
        source: { type: "url", value: "https://example.com/img.png" },
      },
    ]);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: { url: "https://example.com/img.png" },
      },
    ]);
  });

  it("converts data image items", () => {
    const result = convertAguiMultimodalToLangchain([
      {
        type: "image",
        source: { type: "data", value: "base64data", mime_type: "image/png" },
      },
    ]);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,base64data" },
      },
    ]);
  });

  it("converts binary content with url", () => {
    const result = convertAguiMultimodalToLangchain([
      {
        type: "binary",
        url: "https://example.com/file.bin",
        mime_type: "application/octet-stream",
      },
    ]);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: { url: "https://example.com/file.bin" },
      },
    ]);
  });

  it("converts binary content with data", () => {
    const result = convertAguiMultimodalToLangchain([
      {
        type: "binary",
        data: "base64data",
        mime_type: "image/jpeg",
      },
    ]);
    expect(result).toEqual([
      {
        type: "image_url",
        image_url: { url: "data:image/jpeg;base64,base64data" },
      },
    ]);
  });

  it("converts binary content with id fallback", () => {
    const result = convertAguiMultimodalToLangchain([
      { type: "binary", id: "file-123" },
    ]);
    expect(result).toEqual([
      { type: "image_url", image_url: { url: "file-123" } },
    ]);
  });

  it("skips binary content with no url/data/id", () => {
    const result = convertAguiMultimodalToLangchain([
      { type: "binary", mime_type: "application/octet-stream" },
    ]);
    expect(result).toEqual([]);
  });

  it("round-trips text + image content", () => {
    const original = [
      { type: "text" as const, text: "Look at this:" },
      {
        type: "image" as const,
        source: {
          type: "url" as const,
          value: "https://example.com/img.png",
        },
      },
    ];
    const langchain = convertAguiMultimodalToLangchain(original);
    const roundTripped = convertLangchainMultimodalToAgui(
      langchain as Array<Record<string, unknown>>,
    );
    expect(roundTripped).toEqual(original);
  });
});

// ============================================================
// resolveMessageContent
// ============================================================

describe("resolveMessageContent", () => {
  it("returns null for null/undefined", () => {
    expect(resolveMessageContent(null)).toBeNull();
    expect(resolveMessageContent(undefined)).toBeNull();
  });

  it("returns string as-is", () => {
    expect(resolveMessageContent("hello")).toBe("hello");
  });

  it("returns empty string as-is (preserves delta)", () => {
    expect(resolveMessageContent("")).toBe("");
  });

  it("extracts text from content blocks", () => {
    expect(
      resolveMessageContent([
        { type: "thinking", thinking: "..." },
        { type: "text", text: "visible output" },
      ]),
    ).toBe("visible output");
  });

  it("returns null when no text block found", () => {
    expect(
      resolveMessageContent([
        { type: "thinking", thinking: "..." },
      ]),
    ).toBeNull();
  });
});

// ============================================================
// flattenUserContent
// ============================================================

describe("flattenUserContent", () => {
  it("returns empty string for null/undefined", () => {
    expect(flattenUserContent(null)).toBe("");
    expect(flattenUserContent(undefined)).toBe("");
  });

  it("passes through strings", () => {
    expect(flattenUserContent("hello")).toBe("hello");
  });

  it("extracts text from typed content", () => {
    expect(
      flattenUserContent([
        { type: "text", text: "Hello" },
        { type: "image", source: { type: "url", value: "https://example.com/img.png" } },
      ]),
    ).toBe("Hello\n[Image: https://example.com/img.png]");
  });

  it("handles data source images", () => {
    expect(
      flattenUserContent([
        { type: "image", source: { type: "data", value: "base64", mime_type: "image/png" } },
      ]),
    ).toBe("[Image: image/png]");
  });

  it("handles binary content with filename", () => {
    expect(
      flattenUserContent([
        { type: "binary", filename: "doc.pdf" },
      ]),
    ).toBe("[Binary content: doc.pdf]");
  });
});

// ============================================================
// normalizeToolContent
// ============================================================

describe("normalizeToolContent", () => {
  it("normalizes nullish content to an empty string", () => {
    expect(normalizeToolContent(null)).toBe("");
    expect(normalizeToolContent(undefined)).toBe("");
  });

  it("passes through strings", () => {
    expect(normalizeToolContent("result")).toBe("result");
  });

  it("joins string array", () => {
    expect(normalizeToolContent(["part1", "part2"])).toBe("part1part2");
  });

  it("extracts text from content blocks", () => {
    expect(
      normalizeToolContent([
        { type: "text", text: "result text" },
      ]),
    ).toBe("result text");
  });

  it("JSON-stringifies unknown blocks", () => {
    const result = normalizeToolContent([
      { type: "custom", data: "value" },
    ]);
    expect(JSON.parse(result)).toEqual({ type: "custom", data: "value" });
  });

  it("JSON-stringifies non-string/non-array", () => {
    expect(normalizeToolContent({ key: "val" })).toBe('{"key":"val"}');
  });
});
