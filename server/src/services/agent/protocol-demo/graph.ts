import {
  BACKEND_TOOL_CALL_ID,
  FRONTEND_TOOL_CALL_ID,
  SUPERVISOR_HANDOFF_MESSAGE_ID,
  SUPERVISOR_SUMMARY_MESSAGE_ID,
  WRITER_OUTPUT_MESSAGE_ID,
  WRITER_PROGRESS_MESSAGE_ID,
  WRITER_CALC_TOOL_CALL_ID,
  WRITER_HANDOFF_TOOL_CALL_ID,
  chainEnd,
  hasToolResume,
  textChunk,
  textEnd,
  toolCallArgs,
  toolCallStart,
  toolEnd,
  toolResultDelta,
  toolResultEnd,
  toolResultStart,
  type StreamEvent,
} from "./events.js";

function splitIntoChunks(value: string, size = 24): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

function latestUserText(input: unknown): string {
  if (!input || typeof input !== "object" || !("messages" in input)) {
    return "";
  }

  const rawMessages = (input as { messages?: unknown }).messages;
  if (!Array.isArray(rawMessages)) return "";

  for (let index = rawMessages.length - 1; index >= 0; index -= 1) {
    const message = rawMessages[index];
    const type = graphMessageType(message);
    if (
      message &&
      typeof message === "object" &&
      "content" in message &&
      ((message as { role?: unknown }).role === "user" || type === "human") &&
      typeof (message as { content?: unknown }).content === "string"
    ) {
      return (message as { content: string }).content.toLowerCase();
    }
  }

  return "";
}

function graphMessageType(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const getType = (message as { _getType?: unknown })._getType;
  return typeof getType === "function"
    ? (getType.call(message) as string | undefined)
    : undefined;
}

/**
 * Deterministic LangGraph-compatible graph used by the UI Protocol Lab.
 * It intentionally implements only the surface consumed by LangGraphAgent:
 * schema introspection plus streamEvents().
 */
export class ProtocolDemoGraph {
  nodes = {};

  getInputJsonSchema() {
    return {
      properties: {
        messages: {},
        tools: {},
        protocolStage: {},
        artifacts: {},
      },
    };
  }

  getOutputJsonSchema() {
    return {
      properties: {
        messages: {},
        tools: {},
        protocolStage: {},
        artifacts: {},
        approval: {},
      },
    };
  }

  streamEvents(input: unknown) {
    const resumed = hasToolResume(input);
    const userText = latestUserText(input);
    const runSubAgentTreeDemo =
      userText.includes("sub-agent tree demo") ||
      userText.includes("sub agent tree demo") ||
      userText.includes("writer handoff demo");

    async function* generate(): AsyncGenerator<StreamEvent> {
      if (runSubAgentTreeDemo) {
        yield chainEnd("supervisor", {
          protocolStage: "supervisor-routing",
          artifacts: ["deterministic handoff", "step tracking", "writer subtree"],
        });
        yield textChunk(
          "Supervisor received the request and is handing the task to the writer sub-agent. ",
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
        );
        yield toolCallStart(
          WRITER_HANDOFF_TOOL_CALL_ID,
          "transfer_to_writer",
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
        );
        yield toolCallArgs(
          WRITER_HANDOFF_TOOL_CALL_ID,
          {
            task: "Calculate (23 * 45) + (67 / 3) and explain the result in one paragraph.",
          },
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
        );
        yield textEnd("supervisor", SUPERVISOR_HANDOFF_MESSAGE_ID);
        yield toolEnd(
          "transfer_to_writer",
          WRITER_HANDOFF_TOOL_CALL_ID,
          { status: "ok", message: "Successfully transferred to writer" },
          "supervisor",
          {
            task: "Calculate (23 * 45) + (67 / 3) and explain the result in one paragraph.",
          },
          SUPERVISOR_HANDOFF_MESSAGE_ID,
        );

        yield chainEnd("writer", {
          protocolStage: "writer-active",
          artifacts: ["writer step", "calculator tool", "paragraph draft"],
        });
        yield textChunk(
          "Writer accepted the handoff and is calculating the expression before drafting the explanation. ",
          "writer",
          WRITER_PROGRESS_MESSAGE_ID,
        );
        yield toolCallStart(
          WRITER_CALC_TOOL_CALL_ID,
          "calculate",
          "writer",
          WRITER_PROGRESS_MESSAGE_ID,
        );
        yield toolCallArgs(
          WRITER_CALC_TOOL_CALL_ID,
          { expression: "(23 * 45) + (67 / 3)" },
          "writer",
          WRITER_PROGRESS_MESSAGE_ID,
        );
        yield textEnd("writer", WRITER_PROGRESS_MESSAGE_ID);
        const writerCalcResultMessageId = `${WRITER_CALC_TOOL_CALL_ID}-result`;
        const writerCalcResult = JSON.stringify({
          expression: "(23 * 45) + (67 / 3)",
          result: 1057.3333333333333,
        });
        yield toolResultStart(
          WRITER_CALC_TOOL_CALL_ID,
          writerCalcResultMessageId,
          "writer",
          {
            stepName: "writer",
            stepKind: "subagent",
            parentStepName: "supervisor",
          },
        );
        for (const chunk of splitIntoChunks(writerCalcResult)) {
          yield toolResultDelta(
            WRITER_CALC_TOOL_CALL_ID,
            writerCalcResultMessageId,
            chunk,
            "writer",
          );
        }
        yield toolResultEnd(
          WRITER_CALC_TOOL_CALL_ID,
          writerCalcResultMessageId,
          "writer",
        );
        yield toolEnd(
          "calculate",
          WRITER_CALC_TOOL_CALL_ID,
          {
            expression: "(23 * 45) + (67 / 3)",
            result: 1057.3333333333333,
          },
          "writer",
          { expression: "(23 * 45) + (67 / 3)" },
          WRITER_PROGRESS_MESSAGE_ID,
        );
        yield textChunk(
          "When we calculate (23 x 45) + (67 / 3), the result is 1057.3333333333333. The first part, 23 multiplied by 45, gives 1035, and the second part, 67 divided by 3, gives about 22.3333. Adding those two values produces 1057.3333, so the final answer includes a repeating decimal because 67 cannot be divided by 3 into a whole number.",
          "writer",
          WRITER_OUTPUT_MESSAGE_ID,
        );
        yield textEnd("writer", WRITER_OUTPUT_MESSAGE_ID);

        yield chainEnd("supervisor", {
          protocolStage: "supervisor-wrap-up",
          artifacts: ["writer response returned", "final summary"],
        });
        yield textChunk(
          "Supervisor received the writer response and completed the sub-agent tree demo.",
          "supervisor",
          SUPERVISOR_SUMMARY_MESSAGE_ID,
        );
        yield textEnd("supervisor", SUPERVISOR_SUMMARY_MESSAGE_ID);
        return;
      }

      if (resumed) {
        yield chainEnd("approval", {
          protocolStage: "frontend-tool-resolved",
          approval: "received",
          artifacts: ["Command-style resume", "tool result message"],
        });
        yield textChunk("Approval received. Resuming the run with the tool result. ");
        yield textChunk("The protocol path is now complete: text stream, backend tool, state snapshot, frontend tool, and resume.");
        yield textEnd();
        yield chainEnd("finalizer", {
          protocolStage: "complete",
          approval: "accepted",
          artifacts: [
            "TEXT_MESSAGE_*",
            "TOOL_CALL_*",
            "TOOL_CALL_RESULT",
            "STATE_SNAPSHOT",
            "frontend pause/resume",
          ],
        });
        return;
      }

      yield chainEnd("planner", {
        protocolStage: "input-normalized",
        artifacts: ["RunAgentInput", "schema filtering", "step tracking"],
      });
      yield textChunk("Protocol lab started. I will emit a backend tool call, update shared state, then ask for frontend approval. ");
      yield textEnd();

      yield toolCallStart(BACKEND_TOOL_CALL_ID, "protocol_state_probe");
      yield toolCallArgs(BACKEND_TOOL_CALL_ID, {
        inspect: ["state", "messages", "tools"],
      });
      yield textEnd();
      const backendResultMessageId = `${BACKEND_TOOL_CALL_ID}-result`;
      const backendResult = JSON.stringify({
        state: "ok",
        messages: "streamed",
        tools: "deduped",
      });
      yield toolResultStart(BACKEND_TOOL_CALL_ID, backendResultMessageId);
      for (const chunk of splitIntoChunks(backendResult)) {
        yield toolResultDelta(BACKEND_TOOL_CALL_ID, backendResultMessageId, chunk);
      }
      yield toolResultEnd(BACKEND_TOOL_CALL_ID, backendResultMessageId);
      yield toolEnd("protocol_state_probe", BACKEND_TOOL_CALL_ID, {
        state: "ok",
        messages: "streamed",
        tools: "deduped",
      });
      yield chainEnd("backend_tool", {
        protocolStage: "backend-tool-complete",
        artifacts: ["TOOL_CALL_RESULT", "state snapshot"],
      });

      yield toolCallStart(FRONTEND_TOOL_CALL_ID, "confirm_action");
      yield toolCallArgs(FRONTEND_TOOL_CALL_ID, {
        action: "Resume the protocol showcase after frontend approval",
        severity: "medium",
      });
      yield textEnd();
    }

    return generate();
  }
}
