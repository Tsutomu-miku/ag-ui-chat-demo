/**
 * Comprehensive tests for updateMessagesWithAgentEvent reducer.
 *
 * Covers all ThreadAgentEvent types, edge cases, immutability,
 * and the step metadata propagation needed for tree rendering.
 */

import { describe, expect, it } from "vitest";

import type { ChatMessage, ThreadAgentEvent } from "../src/types.js";
import { updateMessagesWithAgentEvent } from "../src/reducer.js";

// ── Helper: apply a sequence of events ──

function applyEvents(
  initial: ChatMessage[],
  events: ThreadAgentEvent[],
): ChatMessage[] {
  return events.reduce(
    (msgs, event) => updateMessagesWithAgentEvent(msgs, event),
    initial,
  );
}

describe("updateMessagesWithAgentEvent", () => {
  // ─── assistant text streaming ───

  describe("assistant text streaming", () => {
    it("folds assistant text streaming into a single message", () => {
      const messages = applyEvents([], [
        { type: "assistant_start", messageId: "a1" },
        { type: "assistant_delta", messageId: "a1", delta: "Hel" },
        { type: "assistant_delta", messageId: "a1", delta: "lo" },
        { type: "assistant_end", messageId: "a1" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "a1",
        role: "assistant",
        content: "Hello",
        isStreaming: false,
      });
    });

    it("creates a placeholder on assistant_start if message does not exist", () => {
      const messages = applyEvents([], [
        { type: "assistant_start", messageId: "new-1" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "new-1",
        role: "assistant",
        content: "",
        isStreaming: true,
      });
    });

    it("marks existing message as streaming on assistant_start", () => {
      const initial: ChatMessage[] = [{
        id: "existing-1",
        role: "assistant",
        content: "Previous",
        isStreaming: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "assistant_start", messageId: "existing-1" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].isStreaming).toBe(true);
    });

    it("creates placeholder on assistant_delta if message missing", () => {
      const messages = applyEvents([], [
        { type: "assistant_delta", messageId: "orphan-1", delta: "text" },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "orphan-1",
        content: "text",
        isStreaming: true,
      });
    });

    it("handles empty delta gracefully", () => {
      const messages = applyEvents([], [
        { type: "assistant_start", messageId: "empty-delta" },
        { type: "assistant_delta", messageId: "empty-delta", delta: "" },
        { type: "assistant_delta", messageId: "empty-delta", delta: "Hi" },
        { type: "assistant_end", messageId: "empty-delta" },
      ]);

      expect(messages[0].content).toBe("Hi");
    });

    it("does not affect unrelated messages", () => {
      const initial: ChatMessage[] = [{
        id: "other",
        role: "user",
        content: "Question",
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "assistant_start", messageId: "a1" },
        { type: "assistant_delta", messageId: "a1", delta: "Answer" },
        { type: "assistant_end", messageId: "a1" },
      ]);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ id: "other", content: "Question" });
      expect(messages[1]).toMatchObject({ id: "a1", content: "Answer" });
    });
  });

  // ─── tool call lifecycle ───

  describe("tool call lifecycle", () => {
    it("adds tool call to parent assistant message on tool_start", () => {
      const messages = applyEvents([], [
        { type: "assistant_start", messageId: "a1" },
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search_web",
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].toolCalls).toHaveLength(1);
      expect(messages[0].toolCalls![0]).toMatchObject({
        id: "tc1",
        type: "function",
        function: { name: "search_web", arguments: "" },
        complete: false,
      });
    });

    it("creates assistant message if tool_start references unknown parent", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "unknown-parent",
          toolCallId: "tc1",
          toolCallName: "calculate",
        },
      ]);

      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("unknown-parent");
      expect(messages[0].toolCalls).toHaveLength(1);
    });

    it("does not add duplicate tool call on repeated tool_start", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search",
        },
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search",
        },
      ]);

      expect(messages[0].toolCalls).toHaveLength(1);
    });

    it("appends tool call argument deltas", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search_web",
        },
        { type: "tool_args", toolCallId: "tc1", delta: '{"query":"hel' },
        { type: "tool_args", toolCallId: "tc1", delta: 'lo"}' },
      ]);

      expect(messages[0].toolCalls![0].function.arguments).toBe(
        '{"query":"hello"}',
      );
    });

    it("tool_args does nothing if tool call not found", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "tool_args", toolCallId: "nonexistent", delta: "data" },
      ]);

      expect(messages).toEqual(initial);
    });

    it("marks tool call complete on tool_end", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "calc",
        },
        { type: "tool_args", toolCallId: "tc1", delta: '{"x":1}' },
        { type: "tool_end", toolCallId: "tc1" },
      ]);

      expect(messages[0].toolCalls![0].complete).toBe(true);
      // No more incomplete tool calls → not streaming
      expect(messages[0].isStreaming).toBe(false);
    });

    it("keeps message streaming if other tool calls still incomplete", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search",
        },
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc2",
          toolCallName: "calculate",
        },
        { type: "tool_end", toolCallId: "tc1" },
      ]);

      expect(messages[0].toolCalls![0].complete).toBe(true);
      expect(messages[0].toolCalls![1].complete).toBe(false);
      expect(messages[0].isStreaming).toBe(true);
    });

    it("tool_end does nothing if tool call not found", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "",
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "tool_end", toolCallId: "nonexistent" },
      ]);

      expect(messages).toEqual(initial);
    });
  });

  // ─── tool call results ───

  describe("tool call results (append_message)", () => {
    it("appends tool result and marks parent tool call complete", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "Calculating...",
        toolCalls: [{
          id: "tc1",
          type: "function",
          function: { name: "calculate", arguments: '{"expression":"2+2"}' },
          complete: false,
        }],
        isStreaming: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [{
        type: "append_message",
        message: {
          id: "tm1",
          role: "tool",
          content: "4",
          toolCallId: "tc1",
          createdAt: "2024-01-01T00:00:01.000Z",
        },
      }]);

      expect(messages).toHaveLength(2);
      expect(messages[0].toolCalls![0].complete).toBe(true);
      expect(messages[1]).toMatchObject({
        id: "tm1",
        role: "tool",
        content: "4",
        toolCallId: "tc1",
      });
    });

    it("does not duplicate messages on repeated append", () => {
      const toolMsg: ChatMessage = {
        id: "tm1",
        role: "tool",
        content: "result",
        toolCallId: "tc1",
        createdAt: "2024-01-01T00:00:00.000Z",
      };

      const messages = applyEvents([], [
        { type: "append_message", message: toolMsg },
        { type: "append_message", message: toolMsg },
      ]);

      expect(messages).toHaveLength(1);
    });

    it("streams tool result content progressively before the final result arrives", () => {
      const messages = applyEvents([], [
        {
          type: "tool_result_start",
          messageId: "tm-stream-1",
          toolCallId: "tc1",
        },
        {
          type: "tool_result_delta",
          messageId: "tm-stream-1",
          toolCallId: "tc1",
          delta: '{"res',
        },
        {
          type: "tool_result_delta",
          messageId: "tm-stream-1",
          toolCallId: "tc1",
          delta: 'ult":4}',
        },
      ]);

      expect(messages).toEqual([
        expect.objectContaining({
          id: "tm-stream-1",
          role: "tool",
          toolCallId: "tc1",
          content: '{"result":4}',
          isStreaming: true,
        }),
      ]);
    });

    it("merges the final tool result into an existing streamed tool message", () => {
      const messages = applyEvents([], [
        {
          type: "tool_result_start",
          messageId: "tm-stream-1",
          toolCallId: "tc1",
        },
        {
          type: "tool_result_delta",
          messageId: "tm-stream-1",
          toolCallId: "tc1",
          delta: '{"res',
        },
        {
          type: "append_message",
          message: {
            id: "tm-stream-1",
            role: "tool",
            content: '{"result":4}',
            toolCallId: "tc1",
            createdAt: "2024-01-01T00:00:01.000Z",
          },
        },
      ]);

      expect(messages).toEqual([
        expect.objectContaining({
          id: "tm-stream-1",
          role: "tool",
          toolCallId: "tc1",
          content: '{"result":4}',
          isStreaming: false,
        }),
      ]);
    });

    it("appends non-tool messages unchanged", () => {
      const messages = applyEvents([], [{
        type: "append_message",
        message: {
          id: "sys1",
          role: "system",
          content: "System message",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      }]);

      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: "sys1",
        role: "system",
        content: "System message",
      });
    });
  });

  // ─── step metadata ───

  describe("step metadata propagation", () => {
    it("preserves step context on assistant_start", () => {
      const messages = applyEvents([], [
        {
          type: "assistant_start",
          messageId: "a1",
          step: {
            name: "researcher",
            parentId: "supervisor",
          },
        },
      ]);

      expect(messages[0]).toMatchObject({
        step: {
          name: "researcher",
          parentId: "supervisor",
        },
      });
    });

    it("propagates step metadata to tool calls on tool_start", () => {
      const messages = applyEvents([], [
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search",
          step: {
            name: "researcher",
            parentId: "supervisor",
          },
        },
      ]);

      expect(messages[0]).toMatchObject({
        id: "a1",
        step: {
          name: "researcher",
          parentId: "supervisor",
        },
      });
      expect(messages[0].toolCalls![0]).toMatchObject({
        step: {
          name: "researcher",
          parentId: "supervisor",
        },
      });
    });

    it("does not overwrite existing step metadata with undefined", () => {
      const messages = applyEvents([], [
        {
          type: "assistant_start",
          messageId: "a1",
          step: {
            name: "writer",
            parentId: "supervisor",
          },
        },
        // Second event without step metadata should not clear existing
        { type: "assistant_start", messageId: "a1" },
      ]);

      expect(messages[0].step?.name).toBe("writer");
      expect(messages[0].step?.parentId).toBe("supervisor");
    });
  });

  // ─── step events (no-op for messages) ───

  describe("step events", () => {
    it("step_started does not modify messages", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "Hello",
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "step_started", step: { name: "researcher" } },
      ]);

      expect(messages).toEqual(initial);
    });

    it("step_finished does not modify messages", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "Hello",
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [
        { type: "step_finished", step: { name: "researcher" } },
      ]);

      expect(messages).toEqual(initial);
    });
  });

  // ─── run_complete ───

  describe("run_complete", () => {
    it("clears all streaming markers", () => {
      const initial: ChatMessage[] = [
        {
          id: "a1",
          role: "assistant",
          content: "Working...",
          isStreaming: true,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "a2",
          role: "assistant",
          content: "Also working...",
          isStreaming: true,
          createdAt: "2024-01-01T00:00:01.000Z",
        },
      ];

      const messages = applyEvents(initial, [{ type: "run_complete" }]);

      expect(messages[0].isStreaming).toBe(false);
      expect(messages[1].isStreaming).toBe(false);
    });

    it("does not modify messages that are already not streaming", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "Done",
        isStreaming: false,
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const messages = applyEvents(initial, [{ type: "run_complete" }]);

      // Same reference — no mutation
      expect(messages[0]).toBe(initial[0]);
    });
  });

  // ─── full integration scenario ───

  describe("full integration scenario", () => {
    it("handles a complete multi-tool conversation flow", () => {
      const messages = applyEvents([], [
        // Assistant starts responding
        { type: "assistant_start", messageId: "a1" },
        { type: "assistant_delta", messageId: "a1", delta: "Let me " },
        { type: "assistant_delta", messageId: "a1", delta: "search for that." },
        { type: "assistant_end", messageId: "a1" },

        // Tool call: search_web
        {
          type: "tool_start",
          parentMessageId: "a1",
          toolCallId: "tc1",
          toolCallName: "search_web",
        },
        { type: "tool_args", toolCallId: "tc1", delta: '{"query":"AI"}' },
        { type: "tool_end", toolCallId: "tc1" },

        // Tool result
        {
          type: "append_message",
          message: {
            id: "tm1",
            role: "tool",
            content: '{"results":["AI is great"]}',
            toolCallId: "tc1",
            createdAt: "2024-01-01T00:00:02.000Z",
          },
        },

        // Assistant continues with another message
        { type: "assistant_start", messageId: "a2" },
        { type: "assistant_delta", messageId: "a2", delta: "Based on my search, " },
        { type: "assistant_delta", messageId: "a2", delta: "AI is great!" },
        { type: "assistant_end", messageId: "a2" },

        // Run complete
        { type: "run_complete" },
      ]);

      expect(messages).toHaveLength(3); // a1 (with tool), tm1, a2
      expect(messages[0]).toMatchObject({
        id: "a1",
        content: "Let me search for that.",
        isStreaming: false,
        toolCalls: [{
          id: "tc1",
          function: { name: "search_web", arguments: '{"query":"AI"}' },
          complete: true,
        }],
      });
      expect(messages[1]).toMatchObject({
        id: "tm1",
        role: "tool",
        content: '{"results":["AI is great"]}',
      });
      expect(messages[2]).toMatchObject({
        id: "a2",
        content: "Based on my search, AI is great!",
        isStreaming: false,
      });
    });

    it("handles supervisor → sub-agent tree structure", () => {
      const messages = applyEvents([], [
        // Supervisor starts
        {
          type: "assistant_start",
          messageId: "supervisor-msg",
          step: { name: "supervisor" },
        },
        {
          type: "assistant_delta",
          messageId: "supervisor-msg",
          delta: "I'll delegate to researcher.",
        },
        { type: "assistant_end", messageId: "supervisor-msg" },

        // Delegation tool call
        {
          type: "tool_start",
          parentMessageId: "supervisor-msg",
          toolCallId: "delegate-tc",
          toolCallName: "delegate_to_subagent",
          step: { name: "supervisor" },
        },
        {
          type: "tool_args",
          toolCallId: "delegate-tc",
          delta: '{"agent":"researcher","task":"research AI"}',
        },
        { type: "tool_end", toolCallId: "delegate-tc" },

        // Sub-agent runs (with parentStepName)
        {
          type: "assistant_start",
          messageId: "researcher-msg",
          step: {
            name: "researcher",
            parentId: "supervisor",
          },
        },
        {
          type: "assistant_delta",
          messageId: "researcher-msg",
          delta: "AI research results...",
        },
        { type: "assistant_end", messageId: "researcher-msg" },

        // Delegation result
        {
          type: "append_message",
          message: {
            id: "delegate-result",
            role: "tool",
            content: "Research complete",
            toolCallId: "delegate-tc",
            createdAt: "2024-01-01T00:00:03.000Z",
          },
        },

        { type: "run_complete" },
      ]);

      expect(messages).toHaveLength(3);

      // Supervisor message with delegation tool call
      expect(messages[0]).toMatchObject({
        id: "supervisor-msg",
        step: { name: "supervisor" },
        toolCalls: [{
          id: "delegate-tc",
          function: { name: "delegate_to_subagent" },
          complete: true,
          step: { name: "supervisor" },
        }],
      });

      // Sub-agent message with parent reference
      expect(messages[1]).toMatchObject({
        id: "researcher-msg",
        step: {
          name: "researcher",
          parentId: "supervisor",
        },
        content: "AI research results...",
      });

      // Delegation result
      expect(messages[2]).toMatchObject({
        id: "delegate-result",
        role: "tool",
        toolCallId: "delegate-tc",
      });
    });
  });

  // ─── immutability ───

  describe("immutability", () => {
    it("returns a new array reference on every event", () => {
      const initial: ChatMessage[] = [];
      const result = updateMessagesWithAgentEvent(initial, {
        type: "assistant_start",
        messageId: "a1",
      });

      expect(result).not.toBe(initial);
    });

    it("does not mutate the input array", () => {
      const initial: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "Hello",
        isStreaming: true,
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const frozen = [...initial];
      updateMessagesWithAgentEvent(initial, {
        type: "assistant_delta",
        messageId: "a1",
        delta: " world",
      });

      // Original should be unchanged
      expect(initial[0].content).toBe(frozen[0].content);
    });

    it("does not mutate tool call arrays", () => {
      const original: ChatMessage[] = [{
        id: "a1",
        role: "assistant",
        content: "",
        toolCalls: [{
          id: "tc1",
          type: "function",
          function: { name: "search", arguments: "" },
          complete: false,
        }],
        createdAt: "2024-01-01T00:00:00.000Z",
      }];

      const originalTcRef = original[0].toolCalls![0];

      updateMessagesWithAgentEvent(original, {
        type: "tool_args",
        toolCallId: "tc1",
        delta: '{"q":"hi"}',
      });

      // Original tool call should be unchanged
      expect(originalTcRef.function.arguments).toBe("");
    });
  });
});
