import { EventType, type BaseEvent } from "@ag-ui/core";

import { makeJsonSafe } from "./convert.js";

export const ROOT_SUBGRAPH_NAME = "root";

/**
 * LangChain chunks are class instances in real runs and plain objects in tests.
 * Keep access in one place so event handlers can stay focused on protocol logic.
 */
export function chunkGet(
  chunk: any,
  key: string,
  defaultValue: any = undefined,
): any {
  if (chunk == null) return defaultValue;
  if (typeof chunk === "object" && key in chunk) return chunk[key];
  return defaultValue;
}

export function dumpJsonSafe(value: unknown): unknown {
  try {
    return makeJsonSafe(value);
  } catch {
    return String(value);
  }
}

/**
 * AG-UI RAW/rawEvent payloads are emitted over SSE. Convert cycles, Dates, Maps,
 * and LangGraph runtime objects into JSON-safe shapes before encoder validation.
 */
export function sanitizeRawPayloads(event: BaseEvent): BaseEvent {
  const mutable = event as any;
  if (mutable.type === EventType.RAW && "event" in mutable) {
    mutable.event = dumpJsonSafe(mutable.event);
  }
  if ("rawEvent" in mutable && mutable.rawEvent !== undefined) {
    mutable.rawEvent = dumpJsonSafe(mutable.rawEvent);
  }
  return event;
}

export function collectInterrupts(tasks: any[] | null): any[] {
  if (!tasks || tasks.length === 0) return [];
  const interrupts: any[] = [];
  for (const task of tasks) {
    interrupts.push(...(task?.interrupts ?? []));
  }
  return interrupts;
}

export function parseResumeInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function getStreamArgs(opts: {
  input: any;
  config?: Record<string, any>;
  subgraphs?: boolean;
  version?: "v1" | "v2";
  context?: Record<string, any>;
}): { input: any; options: Record<string, any> } {
  const options: Record<string, any> = {
    ...(opts.config ?? {}),
    version: opts.version ?? "v2",
    subgraphs: opts.subgraphs ?? false,
  };

  if (opts.context && Object.keys(opts.context).length > 0) {
    options.context = {
      ...((opts.config?.configurable as Record<string, any> | undefined) ??
        {}),
      ...opts.context,
    };
  }

  return { input: opts.input, options };
}
