import { EventType, type BaseEvent } from "@ag-ui/core";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { Command } from "@langchain/langgraph";

import type {
  CheckpointSnapshotLike,
  ForwardedProps,
  InterruptLike,
  RunMetadata,
  SchemaKeys,
  State,
} from "../types.js";
import { LangGraphEventTypes } from "../types.js";
import { getStreamPayloadInput } from "../messages/convert.js";
import { dumpJsonSafe } from "../runtime/stream.js";
import { isRecord } from "../shared/guards.js";
import { snapshotMessages } from "../runtime/graph.js";

export function findRegenerationMessage(opts: {
  checkpointMessages: unknown[];
  langchainMessages: BaseMessage[];
}): BaseMessage | null {
  const nonSystemMessages = opts.langchainMessages.filter(
    (message) =>
      !(message instanceof SystemMessage || message._getType?.() === "system"),
  );

  if (opts.checkpointMessages.length <= nonSystemMessages.length) {
    return null;
  }

  const incomingNonToolIds = new Set(
    opts.langchainMessages
      .filter(
        (message) =>
          message.id &&
          !(message instanceof ToolMessage || message._getType?.() === "tool"),
      )
      .map((message) => message.id),
  );
  const checkpointIds = new Set(
    opts.checkpointMessages
      .filter((message) => isRecord(message) && message.id)
      .map((message) => (message as { id: unknown }).id),
  );

  const isContinuation =
    incomingNonToolIds.size > 0 &&
    [...incomingNonToolIds].every((id) => checkpointIds.has(id));

  if (isContinuation) return null;

  for (let i = opts.langchainMessages.length - 1; i >= 0; i--) {
    const message = opts.langchainMessages[i];
    if (
      message instanceof HumanMessage ||
      message._getType?.() === "human"
    ) {
      return message.id && checkpointIds.has(message.id) ? message : null;
    }
  }

  return null;
}

export function buildInterruptEvents(opts: {
  activeRun: RunMetadata;
  threadId?: string;
  interrupts: InterruptLike[];
}): BaseEvent[] {
  return [
    {
      type: EventType.RUN_STARTED,
      threadId: opts.threadId,
      runId: opts.activeRun.id,
    } as BaseEvent,
    ...opts.interrupts.map(
      (interrupt) =>
        ({
          type: EventType.CUSTOM,
          name: LangGraphEventTypes.OnInterrupt,
          value: dumpJsonSafe(interrupt.value),
        }) as BaseEvent,
    ),
    {
      type: EventType.RUN_FINISHED,
      threadId: opts.threadId,
      runId: opts.activeRun.id,
    } as BaseEvent,
  ];
}

export function buildPreparedStreamInput(opts: {
  activeRun: RunMetadata;
  forwardedProps: ForwardedProps;
  resumeInput: unknown;
  state: State;
  schemaKeys?: SchemaKeys;
}): unknown {
  if (opts.resumeInput) {
    return new Command({ resume: opts.resumeInput });
  }

  const payloadInput = getStreamPayloadInput({
    mode: opts.activeRun.mode ?? "start",
    state: opts.state,
    schemaKeys: opts.schemaKeys ?? {},
  });
  return payloadInput ? { ...opts.forwardedProps, ...payloadInput } : null;
}

export function getCheckpointMessages(
  agentState: CheckpointSnapshotLike,
): unknown[] {
  return snapshotMessages(agentState);
}
