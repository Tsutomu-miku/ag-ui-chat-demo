/**
 * Tests for types.ts — enum values and type structure.
 */

import { describe, expect, it } from "vitest";

import {
  LangGraphEventTypes,
  CustomEventNames,
  AG_UI_TRACE_EVENT_NAME,
  AG_UI_TRACE_PROTOCOL_VERSION,
  createProtocolTracePlugin,
} from "../src/index.js";

describe("LangGraphEventTypes", () => {
  it("has all 11 event types", () => {
    expect(Object.keys(LangGraphEventTypes)).toHaveLength(11);
  });

  it("has correct string values", () => {
    expect(LangGraphEventTypes.OnChainStart).toBe("on_chain_start");
    expect(LangGraphEventTypes.OnChatModelStream).toBe("on_chat_model_stream");
    expect(LangGraphEventTypes.OnToolStart).toBe("on_tool_start");
    expect(LangGraphEventTypes.OnToolEnd).toBe("on_tool_end");
    expect(LangGraphEventTypes.OnInterrupt).toBe("on_interrupt");
  });
});

describe("CustomEventNames", () => {
  it("has all 4 custom event names", () => {
    expect(Object.keys(CustomEventNames)).toHaveLength(4);
  });

  it("has correct string values", () => {
    expect(CustomEventNames.ManuallyEmitMessage).toBe("manually_emit_message");
    expect(CustomEventNames.ManuallyEmitToolCall).toBe("manually_emit_tool_call");
    expect(CustomEventNames.ManuallyEmitState).toBe("manually_emit_state");
    expect(CustomEventNames.Exit).toBe("exit");
  });
});

describe("trace plugin exports", () => {
  it("exports createProtocolTracePlugin", () => {
    expect(createProtocolTracePlugin).toBeTypeOf("function");
  });

  it("exports canonical trace protocol constants", () => {
    expect(AG_UI_TRACE_EVENT_NAME).toBe("ag-ui.trace");
    expect(AG_UI_TRACE_PROTOCOL_VERSION).toBe(2);
  });
});
