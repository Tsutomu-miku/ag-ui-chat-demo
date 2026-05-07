import { ToolMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";

import {
  commandToolMessages,
  getEventDataRecord,
  isCommandLike,
  isToolMessageLike,
} from "../../src/translation/helpers.js";

describe("translation helpers", () => {
  it("recognizes tool messages and command-like outputs", () => {
    const toolMessage = new ToolMessage({
      content: "done",
      tool_call_id: "tc1",
      name: "lookup",
    });

    expect(isToolMessageLike(toolMessage)).toBe(true);
    expect(isToolMessageLike({ _getType: () => "tool" })).toBe(true);
    expect(isToolMessageLike({ role: "assistant" })).toBe(false);

    expect(isCommandLike({ update: { messages: [toolMessage] } })).toBe(true);
    expect(isCommandLike({ update: "not-record" })).toBe(false);
  });

  it("extracts command tool messages and event data records", () => {
    const toolMessage = new ToolMessage({
      content: "done",
      tool_call_id: "tc1",
    });

    expect(commandToolMessages({ update: { messages: [toolMessage, {}] } }))
      .toEqual([toolMessage]);
    expect(getEventDataRecord({ event: "x", data: { ok: true } })).toEqual({
      ok: true,
    });
    expect(getEventDataRecord({ event: "x", data: null })).toEqual({});
  });
});
