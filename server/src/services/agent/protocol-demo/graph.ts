import {
  BACKEND_TOOL_CALL_ID,
  FRONTEND_TOOL_CALL_ID,
  chainEnd,
  hasToolResume,
  textChunk,
  textEnd,
  toolCallArgs,
  toolCallStart,
  toolEnd,
  type StreamEvent,
} from "./events.js";

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

  streamEvents(input: any) {
    const resumed = hasToolResume(input);

    async function* generate(): AsyncGenerator<StreamEvent> {
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
