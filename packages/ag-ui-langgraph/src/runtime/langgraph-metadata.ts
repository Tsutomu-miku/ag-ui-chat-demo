import type { LangGraphStreamEvent } from "../types.js";

export function normalizeCheckpointNamespace(
  checkpointNamespace?: string | null,
): string | undefined {
  if (!checkpointNamespace) return undefined;
  const normalized = checkpointNamespace.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function getCheckpointNamespace(
  sourceEvent?: LangGraphStreamEvent | null,
): string | undefined {
  const checkpointNamespace =
    typeof sourceEvent?.metadata?.langgraph_checkpoint_ns === "string"
      ? sourceEvent.metadata.langgraph_checkpoint_ns
      : undefined;
  return normalizeCheckpointNamespace(checkpointNamespace);
}

export function getLangGraphNodeName(
  sourceEvent?: LangGraphStreamEvent | null,
): string | undefined {
  const nodeName = sourceEvent?.metadata?.langgraph_node;
  return typeof nodeName === "string" && nodeName.length > 0
    ? nodeName
    : undefined;
}
