import { EventType, type BaseEvent } from "@ag-ui/core";

import type { InterruptLike, RunnableConfigLike } from "../types.js";
import { makeJsonSafe } from "./convert.js";

export const ROOT_SUBGRAPH_NAME = "root";

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
  const mutable = event as BaseEvent & {
    event?: unknown;
    rawEvent?: unknown;
  };
  if (mutable.type === EventType.RAW && "event" in mutable) {
    mutable.event = dumpJsonSafe(mutable.event);
  }
  if ("rawEvent" in mutable && mutable.rawEvent !== undefined) {
    mutable.rawEvent = dumpJsonSafe(mutable.rawEvent);
  }
  return event;
}

export function collectInterrupts(
  tasks: Array<{ interrupts?: InterruptLike[] | null }> | null,
): InterruptLike[] {
  if (!tasks || tasks.length === 0) return [];
  const interrupts: InterruptLike[] = [];
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
  input: unknown;
  config?: RunnableConfigLike;
  subgraphs?: boolean;
  version?: "v1" | "v2";
  context?: Record<string, unknown>;
}): { input: unknown; options: RunnableConfigLike } {
  const options: RunnableConfigLike = {
    ...(opts.config ?? {}),
    version: opts.version ?? "v2",
    subgraphs: opts.subgraphs ?? false,
  };

  if (opts.context && Object.keys(opts.context).length > 0) {
    options.context = {
      ...(opts.config?.configurable ?? {}),
      ...opts.context,
    };
  }

  return { input: opts.input, options };
}
