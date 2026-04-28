/**
 * Tests for reasoning content resolution.
 * Aligned with Python resolver tests.
 */

import { describe, expect, it } from "vitest";

import {
  resolveReasoningContent,
  resolveEncryptedReasoningContent,
} from "../src/utils/convert.js";

describe("resolveReasoningContent", () => {
  it("returns null for null input", () => {
    expect(resolveReasoningContent(null)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(resolveReasoningContent({ content: [] })).toBeNull();
  });

  it("returns null for content with no reasoning", () => {
    expect(
      resolveReasoningContent({
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBeNull();
  });

  // ── Anthropic thinking format ──

  it("resolves Anthropic thinking format", () => {
    const result = resolveReasoningContent({
      content: [
        { type: "thinking", thinking: "Let me think about this..." },
      ],
    });
    expect(result).toEqual({
      type: "text",
      text: "Let me think about this...",
      index: 0,
    });
  });

  it("resolves Anthropic thinking with signature", () => {
    const result = resolveReasoningContent({
      content: [
        {
          type: "thinking",
          thinking: "reasoning here",
          signature: "sig123",
          index: 1,
        },
      ],
    });
    expect(result).toEqual({
      type: "text",
      text: "reasoning here",
      index: 1,
      signature: "sig123",
    });
  });

  // ── LangChain standardized format ──

  it("resolves LangChain reasoning format", () => {
    const result = resolveReasoningContent({
      content: [
        { type: "reasoning", reasoning: "Step by step..." },
      ],
    });
    expect(result).toEqual({
      type: "text",
      text: "Step by step...",
      index: 0,
    });
  });

  // ── AWS Bedrock format ──

  it("resolves AWS Bedrock reasoning_content format", () => {
    const result = resolveReasoningContent({
      content: [
        {
          type: "reasoning_content",
          reasoning_content: { text: "bedrock reasoning", signature: "bedsig" },
        },
      ],
    });
    expect(result).toEqual({
      type: "text",
      text: "bedrock reasoning",
      index: 0,
      signature: "bedsig",
    });
  });

  // ── OpenAI Responses API v1 format ──

  it("resolves OpenAI Responses API format", () => {
    const result = resolveReasoningContent({
      content: [
        {
          type: "reasoning",
          summary: [{ text: "summary reasoning", index: 0 }],
        },
      ],
    });
    expect(result).toEqual({
      type: "text",
      text: "summary reasoning",
      index: 0,
    });
  });

  // ── OpenAI legacy format via additional_kwargs ──

  it("resolves OpenAI legacy format via additional_kwargs", () => {
    const result = resolveReasoningContent({
      content: [],
      additional_kwargs: {
        reasoning: {
          summary: [{ text: "legacy reasoning", index: 0 }],
        },
      },
    });
    expect(result).toEqual({
      type: "text",
      text: "legacy reasoning",
      index: 0,
    });
  });

  // ── DeepSeek/Qwen format ──

  it("resolves DeepSeek/Qwen reasoning_content format", () => {
    const result = resolveReasoningContent({
      content: [],
      additional_kwargs: {
        reasoning_content: "Deep reasoning process",
      },
    });
    expect(result).toEqual({
      type: "text",
      text: "Deep reasoning process",
      index: 0,
    });
  });

  it("returns null when additional_kwargs has empty reasoning", () => {
    expect(
      resolveReasoningContent({
        content: [],
        additional_kwargs: {
          reasoning: { summary: [] },
        },
      }),
    ).toBeNull();
  });
});

describe("resolveEncryptedReasoningContent", () => {
  it("returns null for null input", () => {
    expect(resolveEncryptedReasoningContent(null)).toBeNull();
  });

  it("returns null for empty content", () => {
    expect(resolveEncryptedReasoningContent({ content: [] })).toBeNull();
  });

  it("resolves Anthropic redacted_thinking block", () => {
    const result = resolveEncryptedReasoningContent({
      content: [
        { type: "redacted_thinking", data: "encrypted_data_here" },
      ],
    });
    expect(result).toBe("encrypted_data_here");
  });

  it("returns null for non-redacted content", () => {
    const result = resolveEncryptedReasoningContent({
      content: [{ type: "text", text: "normal text" }],
    });
    expect(result).toBeNull();
  });
});
