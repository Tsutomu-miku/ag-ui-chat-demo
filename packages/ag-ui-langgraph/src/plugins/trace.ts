import type { BaseEvent } from "@ag-ui/core";

import type {
  RunMetadata,
  TraceStepKind,
} from "../types.js";

export interface LangGraphPluginContext {
  agentName: string;
  activeRun: RunMetadata | null;
  currentSubgraph: string;
  subgraphs: ReadonlySet<string>;
}

export interface LangGraphPlugin {
  name: string;
  beforeDispatchEvent?: (
    event: BaseEvent,
    context: LangGraphPluginContext,
  ) => BaseEvent | null | void;
  onRunStart?: (context: LangGraphPluginContext) => void;
  onRunFinish?: (context: LangGraphPluginContext) => void;
  clone?: () => LangGraphPlugin;
}

type TraceEvent = BaseEvent &
  Partial<{
    stepName: string;
    step: {
      id?: string;
      parentId?: string;
      kind?: TraceStepKind;
      name?: string;
    };
    toolCallId: string;
    toolCallName: string;
  }>;

type StepIdentity = {
  stepId: string;
  parentStepId?: string;
  stepKind: TraceStepKind;
  stepName: string;
};

function isTraceEvent(event: BaseEvent): event is TraceEvent {
  return typeof event === "object" && event !== null;
}

function classifyStepKind(
  stepName: string,
  context: LangGraphPluginContext,
): TraceStepKind {
  if (stepName === context.agentName || stepName === "supervisor") {
    return "supervisor";
  }

  if (context.subgraphs.has(stepName)) {
    return "subagent";
  }

  return "node";
}

function nextStepId(
  counters: Map<string, number>,
  runId: string,
  stepName: string,
): string {
  const key = `${runId}:${stepName}`;
  const next = (counters.get(key) ?? 0) + 1;
  counters.set(key, next);
  return `${runId}:${stepName}:${next}`;
}

/**
 * @deprecated LangGraphAgent now stamps concrete `agentId`/`agentName`
 * attribution in-band on standard AG-UI events. This plugin remains only for
 * older consumers that still depend on its legacy step metadata.
 */
export function createProtocolTracePlugin(): LangGraphPlugin {
  let currentStep: StepIdentity | null = null;
  let lastSupervisorStepId: string | undefined;
  const toolOwners = new Map<string, StepIdentity>();
  const stepCounters = new Map<string, number>();

  return {
    name: "protocol-trace",

    clone() {
      return createProtocolTracePlugin();
    },

    onRunStart() {
      currentStep = null;
      lastSupervisorStepId = undefined;
      toolOwners.clear();
      stepCounters.clear();
    },

    onRunFinish() {
      currentStep = null;
      lastSupervisorStepId = undefined;
      toolOwners.clear();
      stepCounters.clear();
    },

    beforeDispatchEvent(event, context) {
      if (!isTraceEvent(event)) return event;

      if (event.type === "STEP_STARTED" && event.stepName && context.activeRun?.id) {
        const stepKind = classifyStepKind(event.stepName, context);
        const stepId = nextStepId(stepCounters, context.activeRun.id, event.stepName);
        const parentStepId =
          stepKind === "subagent" ? lastSupervisorStepId : undefined;

        currentStep = {
          stepId,
          ...(parentStepId ? { parentStepId } : {}),
          stepKind,
          stepName: event.stepName,
        };

        if (stepKind === "supervisor") {
          lastSupervisorStepId = stepId;
        }

        return {
          ...event,
          stepId,
          ...(parentStepId ? { parentStepId } : {}),
          stepKind,
          stepName: event.stepName,
        };
      }

      if (event.type === "STEP_FINISHED" && event.stepName) {
        const enriched = {
          ...event,
          ...(currentStep
            ? {
                stepId: currentStep.stepId,
                ...(currentStep.parentStepId
                  ? { parentStepId: currentStep.parentStepId }
                  : {}),
                stepKind: currentStep.stepKind,
                stepName: currentStep.stepName,
              }
            : {}),
        };

        if (currentStep?.stepName === event.stepName) {
          currentStep = null;
        }

        return enriched;
      }

      if (
        event.type === "TOOL_CALL_START" &&
        event.toolCallId &&
        currentStep
      ) {
        toolOwners.set(event.toolCallId, currentStep);
        return {
          ...event,
          stepId: currentStep.stepId,
          ...(currentStep.parentStepId
            ? { parentStepId: currentStep.parentStepId }
            : {}),
          stepKind: currentStep.stepKind,
          stepName: currentStep.stepName,
        };
      }

      if (
        (event.type === "TOOL_CALL_ARGS" ||
          event.type === "TOOL_CALL_END" ||
          event.type === "TOOL_CALL_RESULT") &&
        event.toolCallId
      ) {
        const owner = toolOwners.get(event.toolCallId) ?? currentStep;
        if (!owner) return event;

        if (event.type === "TOOL_CALL_RESULT") {
          toolOwners.delete(event.toolCallId);
        }

        return {
          ...event,
          stepId: owner.stepId,
          ...(owner.parentStepId ? { parentStepId: owner.parentStepId } : {}),
          stepKind: owner.stepKind,
          stepName: owner.stepName,
        };
      }

      if (
        (event.type === "TEXT_MESSAGE_START" ||
          event.type === "TEXT_MESSAGE_END" ||
          event.type === "REASONING_START" ||
          event.type === "REASONING_END") &&
        currentStep
      ) {
        return {
          ...event,
          stepId: currentStep.stepId,
          ...(currentStep.parentStepId
            ? { parentStepId: currentStep.parentStepId }
            : {}),
          stepKind: currentStep.stepKind,
          stepName: currentStep.stepName,
        };
      }

      return event;
    },
  };
}
