import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  mergeEventExtra,
  type LangGraphEventExtension,
  type LangGraphEventExtensionContext,
} from "ag-ui-langgraph";

type VisualizationStep = {
  id?: string;
  parentId?: string;
  kind?: string;
  name: string;
};

type VisualizationOwner = {
  key: string;
  type: string;
  instanceId: string;
  parentKey?: string;
};

type VisualizationPayload = {
  step?: VisualizationStep;
  owner?: VisualizationOwner;
};

type EventWithContext = BaseEvent &
  Partial<{
    messageId: string;
    parentMessageId: string;
    toolCallId: string;
    stepName: string;
    step: VisualizationStep;
    value: unknown;
  }>;

const IGNORED_NAMESPACE_TYPES = new Set(["agent", "tools"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getValueRecord(event: EventWithContext) {
  return isRecord(event.value) ? event.value : null;
}

function getMessageId(event: EventWithContext) {
  return stringValue(event.messageId) ?? stringValue(getValueRecord(event)?.messageId);
}

function getToolCallId(event: EventWithContext) {
  return stringValue(event.toolCallId) ?? stringValue(getValueRecord(event)?.toolCallId);
}

function normalizeSegment(segment: string) {
  const [type, ...rest] = segment.split(":");
  const cleanType = type?.trim();
  if (!cleanType || IGNORED_NAMESPACE_TYPES.has(cleanType)) return null;

  const instanceId = rest.join(":").trim() || cleanType;
  return {
    key: `${cleanType}:${instanceId}`,
    type: cleanType,
    instanceId,
  };
}

function parseCheckpointNamespace(namespace?: string) {
  if (!namespace) return [];

  return namespace
    .split("|")
    .map((segment) => normalizeSegment(segment))
    .filter((segment): segment is Omit<VisualizationOwner, "parentKey"> =>
      Boolean(segment),
    );
}

function findOwnerIndex(
  owners: Array<Omit<VisualizationOwner, "parentKey">>,
  nodeName?: string,
) {
  if (!nodeName) return -1;

  for (let index = owners.length - 1; index >= 0; index -= 1) {
    if (owners[index]?.type === nodeName) return index;
  }

  return -1;
}

function deriveOwner(
  event: EventWithContext,
  context: LangGraphEventExtensionContext,
): VisualizationOwner | null {
  const nodeName =
    stringValue(event.step?.name) ??
    stringValue(event.stepName) ??
    context.langgraph.nodeName;
  const owners = parseCheckpointNamespace(context.langgraph.checkpointNamespace);
  const matchedIndex = findOwnerIndex(owners, nodeName);
  const index = matchedIndex >= 0 ? matchedIndex : owners.length - 1;
  const owner =
    index >= 0
      ? owners[index]
      : nodeName
        ? {
            key: `${nodeName}:${nodeName === context.agentName ? "root" : nodeName}`,
            type: nodeName,
            instanceId: nodeName === context.agentName ? "root" : nodeName,
          }
        : null;

  if (!owner) return null;

  const parent =
    index > 0
      ? owners[index - 1]
      : owner.type !== context.agentName
        ? {
            key: `${context.agentName}:root`,
            type: context.agentName,
            instanceId: "root",
          }
        : null;

  return {
    ...owner,
    ...(parent ? { parentKey: parent.key } : {}),
  };
}

function toVisualizationPayload(owner: VisualizationOwner): VisualizationPayload {
  return {
    owner,
    step: {
      id: owner.key,
      ...(owner.parentKey ? { parentId: owner.parentKey } : {}),
      kind: owner.parentKey ? "subagent" : "agent",
      name: owner.type,
    },
  };
}

function mergeVisualization(
  base: VisualizationPayload | null | undefined,
  next: VisualizationPayload | null | undefined,
): VisualizationPayload | null {
  if (!base && !next) return null;

  return {
    ...(base ?? {}),
    ...(next ?? {}),
  };
}

export function createDemoVisualizationExtension(): LangGraphEventExtension {
  const messageVisualization = new Map<string, VisualizationPayload>();
  const toolCallVisualization = new Map<string, VisualizationPayload>();

  return {
    name: "demo.visualization",
    beforeDispatchEvent(event, context) {
      const eventWithContext = event as EventWithContext;
      const messageId = getMessageId(eventWithContext);
      const toolCallId = getToolCallId(eventWithContext);
      const derivedOwner = deriveOwner(eventWithContext, context);
      let payload = derivedOwner ? toVisualizationPayload(derivedOwner) : null;

      if (messageId) {
        payload = mergeVisualization(
          messageVisualization.get(messageId),
          payload,
        );
        if (payload) messageVisualization.set(messageId, payload);
      }

      if (toolCallId) {
        payload = mergeVisualization(
          toolCallVisualization.get(toolCallId),
          payload,
        );
        if (payload) toolCallVisualization.set(toolCallId, payload);
      }

      if (
        !payload &&
        eventWithContext.parentMessageId &&
        event.type === EventType.TOOL_CALL_START
      ) {
        payload =
          messageVisualization.get(eventWithContext.parentMessageId) ?? null;
      }

      if (!payload) return;

      mergeEventExtra(event, {
        visualization: payload,
      });
    },
    clone: createDemoVisualizationExtension,
  };
}
