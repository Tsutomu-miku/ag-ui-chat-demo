import type { LangGraphStreamEvent, TraceStepKind } from "../types.js";
import {
  buildTraceOwnerKey,
  getCheckpointNamespaceRoot,
  normalizeCheckpointNamespace,
  type AgUiTraceOwner,
} from "../trace.js";

export type TraceOwnerMetadata = AgUiTraceOwner & {
  checkpointNamespace?: string;
  stepName: string;
  kind: TraceStepKind;
};

const INTERNAL_NAMESPACE_ROOTS = new Set(["root", "agent", "tools"]);

export function getCheckpointNamespaceInstance(
  checkpointNamespace?: string | null,
): string | undefined {
  const normalized = normalizeCheckpointNamespace(checkpointNamespace);
  const firstSegment = normalized?.split("|")[0]?.trim();
  return firstSegment && firstSegment.length > 0 ? firstSegment : undefined;
}

function sanitizeAgentType(stepName: string): string {
  const normalized = stepName.trim();
  return normalized.length > 0 ? normalized : "agent";
}

function getTraceAgentType(
  stepName: string,
  checkpointNamespace?: string | null,
): string {
  const namespaceRoot = getCheckpointNamespaceRoot(checkpointNamespace);
  if (namespaceRoot && !INTERNAL_NAMESPACE_ROOTS.has(namespaceRoot)) {
    return namespaceRoot;
  }
  return sanitizeAgentType(stepName);
}

function getTraceInstanceId(
  agentType: string,
  checkpointNamespace?: string | null,
): string {
  return getCheckpointNamespaceInstance(checkpointNamespace) ?? agentType;
}

export function buildTraceOwnerFromSource(opts: {
  runId?: string | null;
  stepName: string;
  kind: TraceStepKind;
  event?: LangGraphStreamEvent | null;
  owner?: Partial<AgUiTraceOwner> | null;
}): TraceOwnerMetadata {
  const checkpointNamespace = normalizeCheckpointNamespace(
    opts.event?.metadata?.langgraph_checkpoint_ns as string | undefined,
  );
  const agentType =
    opts.owner?.type ??
    getTraceAgentType(opts.stepName, checkpointNamespace);
  const instanceId =
    opts.owner?.instanceId ??
    getTraceInstanceId(agentType, checkpointNamespace);
  const ownerKey =
    opts.owner?.key ??
    buildTraceOwnerKey({
      runId: opts.runId,
      agentType,
      instanceId,
    });

  return {
    key: ownerKey,
    type: agentType,
    instanceId,
    ...(opts.owner?.parentKey ? { parentKey: opts.owner.parentKey } : {}),
    ...(checkpointNamespace ? { checkpointNamespace } : {}),
    stepName: opts.stepName,
    kind: opts.kind,
  };
}
