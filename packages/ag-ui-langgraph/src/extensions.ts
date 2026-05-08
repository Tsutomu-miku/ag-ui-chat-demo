import type { BaseEvent } from "@ag-ui/core";

import type { LangGraphStreamEvent, RunMetadata } from "./types.js";
import {
  getCheckpointNamespace,
  getLangGraphNodeName,
} from "./runtime/langgraph-metadata.js";

export type EventExtra = Record<string, unknown>;

export interface LangGraphEventExtensionContext {
  agentName: string;
  activeRun: RunMetadata | null;
  currentSubgraph: string;
  subgraphs: ReadonlySet<string>;
  sourceEvent?: LangGraphStreamEvent | null;
  langgraph: {
    event?: string;
    name?: string;
    nodeName?: string;
    runId?: string;
    checkpointNamespace?: string;
  };
}

export interface LangGraphEventExtension {
  name: string;
  beforeDispatchEvent?: (
    event: BaseEvent,
    context: LangGraphEventExtensionContext,
  ) => BaseEvent | null | void;
  onRunStart?: (context: LangGraphEventExtensionContext) => void;
  onRunFinish?: (context: LangGraphEventExtensionContext) => void;
  clone?: () => LangGraphEventExtension;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mergeEventExtra<T extends BaseEvent>(
  event: T,
  extra: EventExtra,
): T & { extra: EventExtra } {
  const mutable = event as T & { extra?: unknown };
  mutable.extra = {
    ...(isRecord(mutable.extra) ? mutable.extra : {}),
    ...extra,
  };
  return mutable as T & { extra: EventExtra };
}

export function createExtensionContext(opts: {
  agentName: string;
  activeRun: RunMetadata | null;
  currentSubgraph: string;
  subgraphs: ReadonlySet<string>;
  sourceEvent?: LangGraphStreamEvent | null;
}): LangGraphEventExtensionContext {
  const sourceEvent = opts.sourceEvent ?? null;
  const nodeName = getLangGraphNodeName(sourceEvent);
  const checkpointNamespace = getCheckpointNamespace(sourceEvent);
  const runId =
    typeof sourceEvent?.run_id === "string" ? sourceEvent.run_id : undefined;

  return {
    agentName: opts.agentName,
    activeRun: opts.activeRun,
    currentSubgraph: opts.currentSubgraph,
    subgraphs: opts.subgraphs,
    sourceEvent,
    langgraph: {
      ...(sourceEvent?.event ? { event: sourceEvent.event } : {}),
      ...(sourceEvent?.name ? { name: sourceEvent.name } : {}),
      ...(nodeName ? { nodeName } : {}),
      ...(runId ? { runId } : {}),
      ...(checkpointNamespace ? { checkpointNamespace } : {}),
    },
  };
}
