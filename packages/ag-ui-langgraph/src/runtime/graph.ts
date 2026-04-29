import type {
  CheckpointSnapshotLike,
  GraphWithCheckpointing,
  InterruptLike,
  LangGraphStreamEvent,
  LocalCompiledGraph,
  RunnableConfigLike,
  State,
} from "../types.js";
import { isRecord } from "../events/guards.js";

export function detectSubgraphNames(graph: unknown): Set<string> {
  const subgraphs = new Set<string>();
  const nodes = isRecord(graph) && isRecord(graph.nodes) ? graph.nodes : null;
  if (!nodes) return subgraphs;

  for (const [nodeName, node] of Object.entries(nodes)) {
    const bound = isRecord(node) ? node.bound : undefined;
    const constructorName =
      (typeof bound === "object" || typeof bound === "function") && bound !== null
        ? (bound as { constructor?: { name?: unknown } }).constructor?.name
        : undefined;
    if (constructorName === "CompiledStateGraph") {
      subgraphs.add(nodeName);
    }
  }

  return subgraphs;
}

export function asCheckpointGraph(graph: unknown): GraphWithCheckpointing {
  if (!isRecord(graph)) return {};
  return graph as GraphWithCheckpointing;
}

export async function getGraphState(
  graph: unknown,
  config: RunnableConfigLike,
): Promise<CheckpointSnapshotLike | null> {
  const checkpointGraph = asCheckpointGraph(graph);
  if (typeof checkpointGraph.getState !== "function") return null;
  return checkpointGraph.getState(config);
}

export async function updateGraphState(
  graph: unknown,
  config: RunnableConfigLike,
  state: State,
  asNode?: string,
): Promise<unknown> {
  const checkpointGraph = asCheckpointGraph(graph);
  if (typeof checkpointGraph.updateState !== "function") return null;
  return checkpointGraph.updateState(config, state, asNode);
}

export async function getGraphStateHistory(
  graph: unknown,
  config: RunnableConfigLike,
): Promise<CheckpointSnapshotLike[]> {
  const checkpointGraph = asCheckpointGraph(graph);
  if (typeof checkpointGraph.getStateHistory !== "function") {
    throw new Error("Graph does not support getStateHistory");
  }

  const history: CheckpointSnapshotLike[] = [];
  const snapshots = checkpointGraph.getStateHistory(config);
  for await (const snapshot of snapshots) {
    history.push(asCheckpointSnapshot(snapshot));
  }
  return history;
}

export function streamGraphEvents(
  graph: LocalCompiledGraph,
  input: unknown,
  options: RunnableConfigLike,
): AsyncIterable<LangGraphStreamEvent> {
  const runnable = graph as unknown as {
    streamEvents: (
      input: unknown,
      options: RunnableConfigLike,
    ) => AsyncIterable<LangGraphStreamEvent>;
  };
  return runnable.streamEvents(input, options);
}

export function asCheckpointSnapshot(value: unknown): CheckpointSnapshotLike {
  if (!isRecord(value)) return {};
  return value as CheckpointSnapshotLike;
}

export function snapshotValues(snapshot: CheckpointSnapshotLike | null): State {
  const values = snapshot?.values;
  return isRecord(values) ? values : {};
}

export function snapshotMessages(snapshot: CheckpointSnapshotLike | null): unknown[] {
  const messages = snapshotValues(snapshot).messages;
  return Array.isArray(messages) ? messages : [];
}

function toIterableArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "object" && Symbol.iterator in value) {
    return [...(value as Iterable<unknown>)];
  }
  return [];
}

export function collectInterrupts(
  tasks: Iterable<unknown> | unknown[] | null | undefined,
): InterruptLike[] {
  const interrupts: InterruptLike[] = [];
  for (const task of toIterableArray(tasks)) {
    if (!isRecord(task)) continue;
    for (const interrupt of toIterableArray(task.interrupts)) {
      if (isRecord(interrupt)) interrupts.push(interrupt as InterruptLike);
    }
  }
  return interrupts;
}

export function stripCheckpointPins(
  config: RunnableConfigLike,
  threadId: string,
): RunnableConfigLike {
  const configurable = isRecord(config.configurable)
    ? Object.fromEntries(
        Object.entries(config.configurable).filter(
          ([key]) => key !== "checkpoint_id" && key !== "checkpoint_ns",
        ),
      )
    : {};

  return {
    ...config,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}

export async function getCheckpointBeforeMessage(opts: {
  graph: unknown;
  messageId: string;
  threadId: string;
  config?: RunnableConfigLike;
}): Promise<CheckpointSnapshotLike> {
  const historyConfig = opts.config
    ? stripCheckpointPins(opts.config, opts.threadId)
    : { configurable: { thread_id: opts.threadId } };
  const historyList = await getGraphStateHistory(opts.graph, historyConfig);

  historyList.reverse();

  for (let idx = 0; idx < historyList.length; idx++) {
    const snapshot = historyList[idx];
    const messages = snapshotMessages(snapshot);
    const hasMessage = messages.some(
      (message) => isRecord(message) && message.id === opts.messageId,
    );
    if (!hasMessage) continue;

    if (idx === 0) {
      return {
        ...snapshot,
        values: {
          ...snapshotValues(snapshot),
          messages: [],
        },
      };
    }

    const checkpoint = historyList[idx - 1];
    const snapshotValuesWithoutMessages = { ...snapshotValues(snapshot) };
    delete snapshotValuesWithoutMessages.messages;
    return {
      ...checkpoint,
      values: {
        ...snapshotValues(checkpoint),
        ...snapshotValuesWithoutMessages,
      },
    };
  }

  throw new Error(
    `Message ID "${opts.messageId}" not found in history (thread_id=${opts.threadId}, snapshots=${historyList.length})`,
  );
}
