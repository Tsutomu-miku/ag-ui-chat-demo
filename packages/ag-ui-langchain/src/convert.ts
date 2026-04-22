/**
 * AG-UI ↔ LangChain message conversion utilities.
 *
 * TypeScript equivalent of Python ag_ui_langgraph.utils
 * Covers: message conversion, multimodal, content resolution, json-safe
 */

import type { Message, Tool } from "@ag-ui/core";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent,
} from "@langchain/core/messages";
import type { BindToolsInput } from "@langchain/core/language_models/chat_models";

import type {
  LangChainToolCall,
  LangGraphReasoning,
  SchemaKeys,
  State,
} from "./types.js";

// ============================================================
// Primitive helpers
// ============================================================

/**
 * Stringify a value if it is not already a string.
 * Mirrors Python `stringify_if_needed`.
 */
export function stringifyIfNeeded(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item === "string") return item;
  return JSON.stringify(item);
}

/**
 * Extract plain text from LangChain / AG-UI content representations.
 *
 * Handles:
 * - string content
 * - Array<{type, text, ...}> multimodal blocks
 */
export function contentToString(
  content: Message["content"] | MessageContent | undefined,
): string {
  if (!content) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          typeof part === "object" &&
          part !== null &&
          "text" in part &&
          typeof part.text === "string"
        )
          return part.text;
        return `[${"type" in part ? (part as { type: string }).type : "content"}]`;
      })
      .join("\n");
  }

  return String(content);
}

/**
 * Safely parse JSON tool arguments. Returns `{}` on failure.
 */
export function parseToolArgs(
  args: string | undefined,
): Record<string, unknown> {
  try {
    return JSON.parse(args || "{}");
  } catch {
    return {};
  }
}

// ============================================================
// Schema key filtering (aligned with Python)
// ============================================================

const DEFAULT_SCHEMA_KEYS = ["tools"];

export function filterObjectBySchemaKeys(
  obj: Record<string, unknown>,
  schemaKeys: string[],
): Record<string, unknown> {
  if (!obj) return {};
  return Object.fromEntries(
    Object.entries(obj).filter(([k]) => schemaKeys.includes(k)),
  );
}

export function getStreamPayloadInput(opts: {
  mode: string;
  state: State;
  schemaKeys: SchemaKeys;
}): State | null {
  let inputPayload: State | null =
    opts.mode === "start" ? opts.state : null;
  if (inputPayload && opts.schemaKeys?.input) {
    inputPayload = filterObjectBySchemaKeys(inputPayload, [
      ...DEFAULT_SCHEMA_KEYS,
      ...opts.schemaKeys.input,
    ]);
  }
  return inputPayload;
}

// ============================================================
// Multimodal content conversion
// ============================================================

/** AG-UI content item (text or media). Simplified type for TS. */
export type AGUIContentItem =
  | { type: "text"; text: string }
  | {
      type: "image";
      source:
        | { type: "data"; value: string; mime_type: string }
        | { type: "url"; value: string };
    }
  | {
      type: "audio" | "video" | "document";
      source:
        | { type: "data"; value: string; mime_type: string }
        | { type: "url"; value: string };
    }
  | {
      type: "binary";
      url?: string;
      data?: string;
      mime_type?: string;
      id?: string;
      filename?: string;
    };

/**
 * Convert LangChain multimodal content to AG-UI format.
 * Aligned with Python `convert_langchain_multimodal_to_agui`.
 */
export function convertLangchainMultimodalToAgui(
  content: Array<Record<string, unknown>>,
): AGUIContentItem[] {
  const aguiContent: AGUIContentItem[] = [];

  for (const item of content) {
    if (item.type === "text") {
      aguiContent.push({
        type: "text",
        text: String(item.text ?? ""),
      });
    } else if (item.type === "image_url") {
      const imageUrlData = item.image_url as
        | Record<string, unknown>
        | string
        | undefined;
      const url =
        typeof imageUrlData === "string"
          ? imageUrlData
          : typeof imageUrlData === "object" && imageUrlData !== null
            ? String(imageUrlData.url ?? "")
            : "";

      if (url.startsWith("data:")) {
        const [header, data] = url.split(",", 2);
        const mimeType =
          header?.split(":")[1]?.split(";")[0] ?? "image/png";
        aguiContent.push({
          type: "image",
          source: { type: "data", value: data ?? "", mime_type: mimeType },
        });
      } else {
        aguiContent.push({
          type: "image",
          source: { type: "url", value: url },
        });
      }
    }
  }

  return aguiContent;
}

/**
 * Convert AG-UI multimodal content to LangChain format.
 * Aligned with Python `convert_agui_multimodal_to_langchain`.
 */
export function convertAguiMultimodalToLangchain(
  content: AGUIContentItem[],
): Array<Record<string, unknown>> {
  const langchainContent: Array<Record<string, unknown>> = [];

  for (const item of content) {
    if (item.type === "text") {
      langchainContent.push({ type: "text", text: item.text });
    } else if (
      item.type === "image" ||
      item.type === "audio" ||
      item.type === "video" ||
      item.type === "document"
    ) {
      const source = (item as { source: { type: string; value: string; mime_type?: string } }).source;
      let url: string | null = null;

      if (source.type === "data") {
        url = `data:${source.mime_type};base64,${source.value}`;
      } else if (source.type === "url") {
        url = source.value;
      }

      if (url) {
        langchainContent.push({
          type: "image_url",
          image_url: { url },
        });
      }
    } else if (item.type === "binary") {
      const binary = item as {
        type: "binary";
        url?: string;
        data?: string;
        mime_type?: string;
        id?: string;
      };
      if (binary.url) {
        langchainContent.push({
          type: "image_url",
          image_url: { url: binary.url },
        });
      } else if (binary.data) {
        langchainContent.push({
          type: "image_url",
          image_url: {
            url: `data:${binary.mime_type ?? "application/octet-stream"};base64,${binary.data}`,
          },
        });
      } else if (binary.id) {
        langchainContent.push({
          type: "image_url",
          image_url: { url: binary.id },
        });
      }
    }
  }

  return langchainContent;
}

// ============================================================
// AG-UI ↔ LangChain message conversion
// ============================================================

/**
 * Convert AG-UI messages to LangChain messages.
 * Aligned with Python `agui_messages_to_langchain`.
 */
export function aguiMessagesToLangchain(messages: Message[]): BaseMessage[] {
  return toLangChainMessages(messages);
}

/**
 * Convert AG-UI messages to LangChain messages (original name kept for compatibility).
 */
export function toLangChainMessages(messages: Message[]): BaseMessage[] {
  return messages.map((message) => {
    switch (message.role) {
      case "user": {
        // Handle multimodal content
        let content: string | Array<Record<string, unknown>>;
        if (Array.isArray(message.content)) {
          content = convertAguiMultimodalToLangchain(
            message.content as unknown as AGUIContentItem[],
          );
        } else {
          content = contentToString(message.content);
        }
        return new HumanMessage({
          id: message.id,
          content,
          name: message.name,
        });
      }
      case "assistant": {
        const toolCalls = ((message as { toolCalls?: Array<{ id: string; function: { name: string; arguments: string } }> }).toolCalls || []).map(
          (tc) => ({
            id: tc.id,
            name: tc.function.name,
            args: parseToolArgs(tc.function.arguments),
            type: "tool_call" as const,
          }),
        );
        return new AIMessage({
          id: message.id,
          content: contentToString(message.content) || "",
          name: message.name,
          tool_calls: toolCalls,
        });
      }
      case "tool":
        return new ToolMessage({
          id: message.id,
          content:
            typeof message.content === "string"
              ? message.content
              : contentToString(message.content),
          tool_call_id: (message as { toolCallId?: string }).toolCallId ?? "",
        });
      case "system":
      case "developer":
        return new SystemMessage({
          id: message.id,
          content:
            typeof message.content === "string"
              ? message.content
              : contentToString(message.content),
          name: message.name,
        });
      default:
        return new HumanMessage(contentToString(message.content));
    }
  });
}

/**
 * Convert LangChain messages to AG-UI messages.
 * Aligned with Python `langchain_messages_to_agui`.
 */
export function langchainMessagesToAgui(messages: BaseMessage[]): Message[] {
  return messages.map((message) => {
    if (message instanceof HumanMessage) {
      let content: string | AGUIContentItem[];
      if (Array.isArray(message.content)) {
        content = convertLangchainMultimodalToAgui(
          message.content as Array<Record<string, unknown>>,
        );
      } else {
        content = stringifyIfNeeded(resolveMessageContent(message.content));
      }
      return {
        id: String(message.id ?? ""),
        role: "user" as const,
        content,
        name: message.name,
      };
    }

    if (message instanceof AIMessage) {
      const toolCalls = message.tool_calls?.length
        ? message.tool_calls.map((tc) => ({
            id: String(tc.id ?? ""),
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args ?? {}),
            },
          }))
        : undefined;

      return {
        id: String(message.id ?? ""),
        role: "assistant" as const,
        content: stringifyIfNeeded(resolveMessageContent(message.content)),
        toolCalls,
        name: message.name,
      };
    }

    if (message instanceof SystemMessage) {
      return {
        id: String(message.id ?? ""),
        role: "system" as const,
        content: stringifyIfNeeded(resolveMessageContent(message.content)),
        name: message.name,
      };
    }

    if (message instanceof ToolMessage) {
      return {
        id: String(message.id ?? ""),
        role: "tool" as const,
        content: stringifyIfNeeded(resolveMessageContent(message.content)),
        toolCallId: message.tool_call_id,
      };
    }

    throw new TypeError(`Unsupported message type: ${message.constructor.name}`);
  }) as Message[];
}

// ============================================================
// Content resolution helpers (aligned with Python)
// ============================================================

/**
 * Resolve message content to plain string.
 * Aligned with Python `resolve_message_content`.
 */
export function resolveMessageContent(content: unknown): string | null {
  if (content === null || content === undefined) return null;
  if (typeof content === "string") return content;

  if (Array.isArray(content) && content.length > 0) {
    const textBlock = content.find(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        (c as Record<string, unknown>).type === "text",
    ) as Record<string, unknown> | undefined;
    return textBlock ? String(textBlock.text ?? null) : null;
  }

  return null;
}

/**
 * Flatten multimodal user content into plain text.
 * Aligned with Python `flatten_user_content`.
 */
export function flattenUserContent(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (typeof item !== "object" || item === null) continue;
      const typed = item as Record<string, unknown>;

      if (typed.type === "text" && typed.text) {
        parts.push(String(typed.text));
      } else if (
        typed.type === "image" ||
        typed.type === "audio" ||
        typed.type === "video" ||
        typed.type === "document"
      ) {
        const label =
          String(typed.type).charAt(0).toUpperCase() +
          String(typed.type).slice(1);
        const source = typed.source as Record<string, unknown> | undefined;
        if (source?.type === "url") {
          parts.push(`[${label}: ${source.value}]`);
        } else if (source?.type === "data") {
          parts.push(`[${label}: ${source.mime_type}]`);
        } else {
          parts.push(`[${label}]`);
        }
      } else if (typed.type === "binary") {
        if (typed.filename) {
          parts.push(`[Binary content: ${typed.filename}]`);
        } else if (typed.url) {
          parts.push(`[Binary content: ${typed.url}]`);
        } else {
          parts.push(`[Binary content: ${typed.mime_type ?? "unknown"}]`);
        }
      }
    }
    return parts.join("\n");
  }

  return String(content);
}

/**
 * Normalize tool message content to a string.
 * Aligned with Python `normalize_tool_content`.
 */
export function normalizeToolContent(content: unknown): string {
  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        if (
          typeof block === "object" &&
          block !== null &&
          (block as Record<string, unknown>).type === "text"
        ) {
          return String((block as Record<string, unknown>).text ?? "");
        }
        return JSON.stringify(block);
      })
      .join("");
  }

  return JSON.stringify(content);
}

// ============================================================
// Reasoning content resolution (aligned with Python)
// ============================================================

function dualGet<T>(obj: unknown, key: string, defaultVal?: T): T | undefined {
  if (obj === null || obj === undefined) return defaultVal;
  if (typeof obj === "object") {
    if (key in (obj as Record<string, unknown>)) {
      return (obj as Record<string, unknown>)[key] as T;
    }
  }
  return defaultVal;
}

/**
 * Resolve reasoning content from various LLM provider formats.
 * Aligned with Python `resolve_reasoning_content`.
 */
export function resolveReasoningContent(
  chunk: unknown,
): LangGraphReasoning | null {
  const content = dualGet<unknown[]>(chunk, "content");

  if (Array.isArray(content) && content.length > 0 && content[0]) {
    const block = content[0] as Record<string, unknown>;
    const blockType = block.type;

    // Anthropic thinking format
    if (blockType === "thinking" && block.thinking) {
      const result: LangGraphReasoning = {
        text: String(block.thinking),
        type: "text",
        index: typeof block.index === "number" ? block.index : 0,
      };
      if (block.signature) result.signature = String(block.signature);
      return result;
    }

    // LangChain standardized reasoning format
    if (blockType === "reasoning" && block.reasoning) {
      return {
        text: String(block.reasoning),
        type: "text",
        index: typeof block.index === "number" ? block.index : 0,
      };
    }

    // AWS Bedrock Converse format
    if (
      blockType === "reasoning_content" &&
      typeof block.reasoning_content === "object" &&
      block.reasoning_content !== null
    ) {
      const rc = block.reasoning_content as Record<string, unknown>;
      if (rc.text) {
        const result: LangGraphReasoning = {
          text: String(rc.text),
          type: "text",
          index: typeof block.index === "number" ? block.index : 0,
        };
        if (rc.signature) result.signature = String(rc.signature);
        return result;
      }
    }

    // OpenAI Responses API v1 format
    if (blockType === "reasoning" && Array.isArray(block.summary)) {
      const summaries = block.summary as Array<Record<string, unknown>>;
      if (summaries.length > 0 && summaries[0]?.text) {
        return {
          type: "text",
          text: String(summaries[0].text),
          index:
            typeof summaries[0].index === "number" ? summaries[0].index : 0,
        };
      }
    }
  }

  // OpenAI legacy format via additional_kwargs
  const additionalKwargs = dualGet<Record<string, unknown>>(
    chunk,
    "additional_kwargs",
  );
  if (additionalKwargs) {
    const reasoning = additionalKwargs.reasoning as
      | Record<string, unknown>
      | undefined;
    const summary = (
      reasoning && Array.isArray(reasoning.summary) ? reasoning.summary : []
    ) as Array<Record<string, unknown>>;
    if (summary.length > 0 && summary[0]?.text) {
      return {
        type: "text",
        text: String(summary[0].text),
        index: typeof summary[0].index === "number" ? summary[0].index : 0,
      };
    }

    // DeepSeek / Qwen / xAI format
    const reasoningContent = additionalKwargs.reasoning_content;
    if (reasoningContent && typeof reasoningContent === "string") {
      return { type: "text", text: reasoningContent, index: 0 };
    }
  }

  return null;
}

/**
 * Resolve encrypted reasoning content (Anthropic redacted thinking).
 * Aligned with Python `resolve_encrypted_reasoning_content`.
 */
export function resolveEncryptedReasoningContent(
  chunk: unknown,
): string | null {
  const content = dualGet<unknown[]>(chunk, "content");
  if (
    !Array.isArray(content) ||
    content.length === 0 ||
    !content[0]
  )
    return null;

  const block = content[0] as Record<string, unknown>;
  if (block.type === "redacted_thinking" && block.data) {
    return String(block.data);
  }

  return null;
}

// ============================================================
// Tool / model helpers
// ============================================================

/**
 * Convert an AG-UI frontend tool definition to a LangChain BindToolsInput.
 */
export function frontendToolToModelTool(tool: Tool): BindToolsInput {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || {
        type: "object",
        properties: {},
      },
    },
  };
}

/**
 * Extract tool calls from a LangChain message.
 */
export function getToolCalls(
  message: BaseMessage | undefined,
): LangChainToolCall[] {
  if (!(message instanceof AIMessage)) return [];

  return (message.tool_calls || []).map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    args: toolCall.args,
  }));
}

/**
 * Normalize a maybe-array value into an array.
 */
export function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

// ============================================================
// JSON-safe serialization (aligned with Python)
// ============================================================

/**
 * Convert any value into a JSON-serializable representation.
 * Aligned with Python `make_json_safe`.
 *
 * Rules:
 * - primitives → as-is
 * - Date → ISO string
 * - Array/Set → array of safe values
 * - Map → object of safe key/value pairs
 * - Plain objects → recursively made safe (skips "runtime"/"config" keys)
 * - Objects with toJSON() → call toJSON() then recurse
 * - Cycles → "<recursive>"
 * - Everything else → String(value)
 */
export function makeJsonSafe(
  value: unknown,
  seen?: Set<unknown>,
): unknown {
  if (!seen) seen = new Set();

  // Primitives
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  // Cycle detection for reference types
  if (typeof value === "object" && seen.has(value)) {
    return "<recursive>";
  }

  // Date
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Array
  if (Array.isArray(value)) {
    seen.add(value);
    return value.map((v) => makeJsonSafe(v, seen));
  }

  // Set / Map
  if (value instanceof Set) {
    seen.add(value);
    return [...value].map((v) => makeJsonSafe(v, seen));
  }

  if (value instanceof Map) {
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [k, v] of value) {
      result[String(makeJsonSafe(k, seen))] = makeJsonSafe(v, seen);
    }
    return result;
  }

  // Plain objects / class instances
  if (typeof value === "object") {
    seen.add(value);

    // toJSON support (e.g. Pydantic-like models)
    if (
      "toJSON" in value &&
      typeof (value as { toJSON: unknown }).toJSON === "function"
    ) {
      try {
        return makeJsonSafe(
          (value as { toJSON: () => unknown }).toJSON(),
          seen,
        );
      } catch {
        // fall through
      }
    }

    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      // Skip runtime/config keys (LangGraph-injected, not serializable)
      if (k === "runtime" || k === "config") continue;
      result[makeJsonSafe(k, seen) as string] = makeJsonSafe(v, seen);
    }
    return result;
  }

  // Fallback
  return String(value);
}

/**
 * Fallback JSON replacer function.
 * Aligned with Python `json_safe_stringify`.
 */
export function jsonSafeStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val instanceof Date) return val.toISOString();
    try {
      return makeJsonSafe(val);
    } catch {
      return String(val);
    }
  });
}

/**
 * Convert camelCase to snake_case.
 * Aligned with Python `camel_to_snake`.
 */
export function camelToSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
