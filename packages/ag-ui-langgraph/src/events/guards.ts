import type {
  LangGraphStreamEvent,
  PredictStateTool,
  ToolCallChunk,
} from "../types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(
  value: unknown,
  key: string,
): unknown | undefined {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function stringValue(
  value: unknown,
  key: string,
): string | undefined {
  const item = recordValue(value, key);
  return typeof item === "string" ? item : undefined;
}

export function arrayValue(value: unknown, key: string): unknown[] {
  const item = recordValue(value, key);
  return Array.isArray(item) ? item : [];
}

export function chunkGet<T = unknown>(
  chunk: unknown,
  key: string,
  defaultValue?: T,
): T | undefined {
  if (!isRecord(chunk) || !(key in chunk)) return defaultValue;
  return chunk[key] as T;
}

export function asLangGraphStreamEvent(value: unknown): LangGraphStreamEvent {
  if (!isRecord(value)) {
    return { event: "unknown", data: value, metadata: {} };
  }

  return {
    event: typeof value.event === "string" ? value.event : "unknown",
    name: typeof value.name === "string" ? value.name : undefined,
    data: value.data,
    metadata: isRecord(value.metadata) ? value.metadata : {},
    run_id: value.run_id,
  };
}

function asToolCallChunk(value: unknown): ToolCallChunk | null {
  if (!isRecord(value)) return null;
  return {
    id: typeof value.id === "string" ? value.id : undefined,
    name: typeof value.name === "string" ? value.name : undefined,
    args: value.args,
    index: typeof value.index === "number" ? value.index : undefined,
  };
}

function asLegacyToolCallChunk(
  value: unknown,
  fallbackIndex: number,
): ToolCallChunk | null {
  if (!isRecord(value)) return null;
  const fn = isRecord(value.function) ? value.function : null;
  const id = typeof value.id === "string" ? value.id : undefined;
  const name =
    typeof value.name === "string"
      ? value.name
      : fn && typeof fn.name === "string"
        ? fn.name
        : undefined;
  const args =
    "args" in value
      ? value.args
      : fn && "arguments" in fn
        ? fn.arguments
        : undefined;
  const index =
    typeof value.index === "number" ? value.index : fallbackIndex;

  if (id === undefined && name === undefined && args === undefined) {
    return null;
  }

  return {
    id,
    name,
    args,
    index,
  };
}

export function getToolCallChunks(chunk: unknown): ToolCallChunk[] {
  const directChunks = arrayValue(chunk, "tool_call_chunks")
    .map(asToolCallChunk)
    .filter((item): item is ToolCallChunk => item !== null);
  if (directChunks.length > 0) return directChunks;

  const toolCalls = arrayValue(chunk, "tool_calls")
    .map((item, index) => asLegacyToolCallChunk(item, index))
    .filter((item): item is ToolCallChunk => item !== null);
  if (toolCalls.length > 0) return toolCalls;

  const additionalKwargs = isRecord(chunk) ? recordValue(chunk, "additional_kwargs") : undefined;
  return arrayValue(additionalKwargs, "tool_calls")
    .map((item, index) => asLegacyToolCallChunk(item, index))
    .filter((item): item is ToolCallChunk => item !== null);
}

export function getPredictStateTools(
  metadata: Record<string, unknown>,
): Array<PredictStateTool | Record<string, unknown> | string> {
  const raw = metadata.predict_state;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (typeof item === "string") return item;
      if (!isRecord(item)) return null;
      return item;
    })
    .filter(
      (item): item is PredictStateTool | Record<string, unknown> | string =>
        item !== null,
    );
}

export function hasPredictStateTool(
  metadata: Record<string, unknown>,
  toolName: string,
): boolean {
  return getPredictStateTools(metadata).some((item) =>
    typeof item === "string" ? item === toolName : item.tool === toolName,
  );
}

export function getSubgraphInfo(opts: {
  eventType: string;
  metadata: Record<string, unknown>;
  subgraphs: Set<string>;
  streamSubgraphs: boolean;
}): { currentSubgraph: string | null; isSubgraphStream: boolean } {
  const ns =
    typeof opts.metadata.langgraph_checkpoint_ns === "string"
      ? opts.metadata.langgraph_checkpoint_ns
      : "";
  const nsRoot = ns ? ns.split("|")[0].split(":")[0] : "";
  const currentSubgraph =
    nsRoot && opts.subgraphs.has(nsRoot) ? nsRoot : null;

  if (!opts.streamSubgraphs) {
    return { currentSubgraph, isSubgraphStream: false };
  }

  return {
    currentSubgraph,
    isSubgraphStream:
      opts.eventType.startsWith("events") ||
      opts.eventType.startsWith("values") ||
      ns.includes("|") ||
      currentSubgraph !== null,
  };
}
