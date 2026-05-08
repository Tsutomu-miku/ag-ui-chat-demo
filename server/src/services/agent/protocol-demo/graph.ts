import {
  BACKEND_TOOL_CALL_ID,
  FRONTEND_TOOL_CALL_ID,
  RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
  RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
  RESEARCHER_HANDOFF_TOOL_CALL_ID,
  SUPERVISOR_HANDOFF_MESSAGE_ID,
  SUPERVISOR_SUMMARY_MESSAGE_ID,
  WRITER_OUTPUT_MESSAGE_ID,
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
    const runParallelSubAgentDemo =
      userText.includes("parallel writer demo") ||
      userText.includes("parallel sub-agent demo") ||
      userText.includes("parallel sub agent demo");
    const runResearchFanoutDemo =
      runSubAgentTreeDemo || runParallelSubAgentDemo;

    async function* generate(): AsyncGenerator<StreamEvent> {
      if (runResearchFanoutDemo) {
        const supervisorNs = {
          langgraph_checkpoint_ns: "supervisor:root|agent:1",
        };
        const researcherFindings = [
          {
            namespace: { langgraph_checkpoint_ns: "researcher:alpha|agent:1" },
            messageId: RESEARCHER_ALPHA_OUTPUT_MESSAGE_ID,
            task: "Research enterprise workflow use cases for AG-UI agents.",
            content:
              "Researcher alpha found enterprise workflow examples including approval routing, support triage, and internal operations copilots.",
          },
          {
            namespace: { langgraph_checkpoint_ns: "researcher:beta|agent:1" },
            messageId: RESEARCHER_BETA_OUTPUT_MESSAGE_ID,
            task: "Research product-facing use cases for AG-UI agents.",
            content:
              "Researcher beta found product-facing patterns including onboarding copilots, guided search, and personalized assistant workflows.",
          },
        ];

        yield chainEnd(
          "supervisor",
          {
            protocolStage: "research-fanout-routing",
            artifacts: [
              "supervisor",
              "same-name researchers",
              "extra visualization",
            ],
          },
          supervisorNs,
        );
        yield textChunk(
          "Supervisor is spawning multiple researcher instances. ",
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
          supervisorNs,
        );
        yield toolCallStart(
          RESEARCHER_HANDOFF_TOOL_CALL_ID,
          "transfer_to_researcher",
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
          supervisorNs,
        );
        yield toolCallArgs(
          RESEARCHER_HANDOFF_TOOL_CALL_ID,
          {
            tasks: researcherFindings.map((researcher) => researcher.task),
          },
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
          supervisorNs,
        );
        yield textEnd(
          "supervisor",
          SUPERVISOR_HANDOFF_MESSAGE_ID,
          supervisorNs,
        );
        yield toolEnd(
          "transfer_to_researcher",
          RESEARCHER_HANDOFF_TOOL_CALL_ID,
          { status: "ok", mode: "fanout" },
          "supervisor",
          { tasks: researcherFindings.map((researcher) => researcher.task) },
          SUPERVISOR_HANDOFF_MESSAGE_ID,
          supervisorNs,
        );

        for (const [index, researcher] of researcherFindings.entries()) {
          yield chainEnd(
            "researcher",
            {
              protocolStage: `researcher-${index + 1}`,
              artifacts: ["research output"],
            },
            researcher.namespace,
          );
          yield textChunk(
            researcher.content,
            "researcher",
            researcher.messageId,
            researcher.namespace,
          );
          yield textEnd(
            "researcher",
            researcher.messageId,
            researcher.namespace,
          );
        }

        yield chainEnd(
          "supervisor",
          {
            protocolStage: "research-fan-in",
            artifacts: ["research merged", "writer brief prepared"],
          },
          supervisorNs,
        );
        yield textChunk(
          "Supervisor merged the research findings and handed a concise brief to the writer. ",
          "supervisor",
          SUPERVISOR_SUMMARY_MESSAGE_ID,
          supervisorNs,
        );
        yield toolCallStart(
          WRITER_HANDOFF_TOOL_CALL_ID,
          "transfer_to_writer",
          "supervisor",
          SUPERVISOR_SUMMARY_MESSAGE_ID,
          supervisorNs,
        );
        yield toolCallArgs(
          WRITER_HANDOFF_TOOL_CALL_ID,
          {
            brief:
              "Combine enterprise workflow and product-facing AG-UI use cases into one concise implementation brief.",
          },
          "supervisor",
          SUPERVISOR_SUMMARY_MESSAGE_ID,
          supervisorNs,
        );
        yield textEnd("supervisor", SUPERVISOR_SUMMARY_MESSAGE_ID, {
          ...supervisorNs,
        });
        yield toolEnd(
          "transfer_to_writer",
          WRITER_HANDOFF_TOOL_CALL_ID,
          { status: "ok", mode: "single-writer" },
          "supervisor",
          {
            brief:
              "Combine enterprise workflow and product-facing AG-UI use cases into one concise implementation brief.",
          },
          SUPERVISOR_SUMMARY_MESSAGE_ID,
          supervisorNs,
        );
        yield chainEnd(
          "writer",
          {
            protocolStage: "writer-final-draft",
            artifacts: ["implementation brief"],
          },
          { langgraph_checkpoint_ns: "writer:final|agent:1" },
        );
        yield textChunk(
          "The writer produced a compact brief covering enterprise workflow automation, customer-facing assistants, and a phased rollout plan for AG-UI agents.",
          "writer",
          WRITER_OUTPUT_MESSAGE_ID,
          { langgraph_checkpoint_ns: "writer:final|agent:1" },
        );
        yield textEnd("writer", WRITER_OUTPUT_MESSAGE_ID, {
          langgraph_checkpoint_ns: "writer:final|agent:1",
        });
        return;
      }

      if (resumed) {
        yield chainEnd("approval", {
          protocolStage: "frontend-tool-resolved",
          approval: "received",
          artifacts: ["Command-style resume", "tool result message"],
        });
        yield textChunk(
          "Approval received. Resuming the run with the tool result. ",
        );
        yield textChunk(
          "The protocol path is now complete: text stream, backend tool, state snapshot, frontend tool, and resume.",
        );
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
      yield textChunk(
        "Protocol lab started. I will emit a backend tool call, update shared state, then ask for frontend approval. ",
      );
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
        yield toolResultDelta(
          BACKEND_TOOL_CALL_ID,
          backendResultMessageId,
          chunk,
        );
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
