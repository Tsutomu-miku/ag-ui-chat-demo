/**
 * Tests for types.ts — enum values and type structure.
 */

import { describe, expect, it } from "vitest";

import {
  LangGraphEventTypesEnum,
  CustomEventNamesEnum,
} from "../src/index.js";

describe("LangGraphEventTypes", () => {
  it("has all 11 event types", () => {
    expect(Object.keys(LangGraphEventTypesEnum)).toHaveLength(11);
  });

  it("has correct string values", () => {
    expect(LangGraphEventTypesEnum.OnChainStart).toBe("on_chain_start");
    expect(LangGraphEventTypesEnum.OnChatModelStream).toBe("on_chat_model_stream");
    expect(LangGraphEventTypesEnum.OnToolStart).toBe("on_tool_start");
    expect(LangGraphEventTypesEnum.OnToolEnd).toBe("on_tool_end");
    expect(LangGraphEventTypesEnum.OnInterrupt).toBe("on_interrupt");
  });
});

describe("CustomEventNames", () => {
  it("has all 4 custom event names", () => {
    expect(Object.keys(CustomEventNamesEnum)).toHaveLength(4);
  });

  it("has correct string values", () => {
    expect(CustomEventNamesEnum.ManuallyEmitMessage).toBe("manually_emit_message");
    expect(CustomEventNamesEnum.ManuallyEmitToolCall).toBe("manually_emit_tool_call");
    expect(CustomEventNamesEnum.ManuallyEmitState).toBe("manually_emit_state");
    expect(CustomEventNamesEnum.Exit).toBe("exit");
  });
});
