import { EventType, type BaseEvent } from "@ag-ui/core";
import { v4 as uuid } from "uuid";

import type {
  LangGraphReasoning,
  RunMetadata,
} from "../types.js";

export type ReasoningHandlerContext = {
  activeRun: RunMetadata | null;
  dispatchEvent: (event: BaseEvent) => BaseEvent | null;
};

export function* handleReasoningEvent(
  ctx: ReasoningHandlerContext,
  reasoningData: LangGraphReasoning | null,
  encryptedData: string | null,
  parentMessageId?: string | null,
): Generator<BaseEvent> {
  if (!ctx.activeRun) return;

  const reasoningProcess = ctx.activeRun.reasoning_process;

  if (encryptedData && reasoningProcess) {
    const ev = ctx.dispatchEvent({
      type: EventType.REASONING_ENCRYPTED_VALUE,
      subtype: "message",
      entityId: reasoningProcess.message_id,
      encryptedValue: encryptedData,
    } as BaseEvent);
    if (ev) yield ev;
    return;
  }

  if (reasoningData) {
    if (!reasoningData.type || reasoningData.text === undefined) return;

    const reasoningStepIndex = reasoningData.index ?? 0;

    if (
      reasoningProcess &&
      reasoningProcess.index !== undefined &&
      reasoningProcess.index !== reasoningStepIndex
    ) {
      const msgId = reasoningProcess.message_id ?? uuid();
      if (reasoningProcess.type) {
        const ev = ctx.dispatchEvent({
          type: EventType.REASONING_MESSAGE_END,
          messageId: msgId,
        } as BaseEvent);
        if (ev) yield ev;
      }
      const ev = ctx.dispatchEvent({
        type: EventType.REASONING_END,
        messageId: msgId,
      } as BaseEvent);
      if (ev) yield ev;
      ctx.activeRun.reasoning_process = null;
    }

    if (!ctx.activeRun.reasoning_process) {
      const messageId = parentMessageId || uuid();
      const ev = ctx.dispatchEvent({
        type: EventType.REASONING_START,
        messageId,
      } as BaseEvent);
      if (ev) yield ev;

      ctx.activeRun.reasoning_process = {
        index: reasoningStepIndex,
        message_id: messageId,
      };
    }

    if (ctx.activeRun.reasoning_process!.type !== reasoningData.type) {
      const ev = ctx.dispatchEvent({
        type: EventType.REASONING_MESSAGE_START,
        messageId: ctx.activeRun.reasoning_process!.message_id,
        role: "reasoning",
      } as BaseEvent);
      if (ev) yield ev;
      ctx.activeRun.reasoning_process!.type = reasoningData.type;
    }

    if (reasoningData.signature) {
      ctx.activeRun.reasoning_process!.signature = reasoningData.signature;
    }

    if (ctx.activeRun.reasoning_process!.type) {
      const ev = ctx.dispatchEvent({
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: ctx.activeRun.reasoning_process!.message_id,
        delta: reasoningData.text,
      } as BaseEvent);
      if (ev) yield ev;
    }
  } else if (reasoningProcess) {
    const msgId = reasoningProcess.message_id ?? uuid();

    if (reasoningProcess.signature) {
      const ev = ctx.dispatchEvent({
        type: EventType.REASONING_ENCRYPTED_VALUE,
        subtype: "message",
        entityId: msgId,
        encryptedValue: reasoningProcess.signature,
      } as BaseEvent);
      if (ev) yield ev;
    }

    const endMsgEv = ctx.dispatchEvent({
      type: EventType.REASONING_MESSAGE_END,
      messageId: msgId,
    } as BaseEvent);
    if (endMsgEv) yield endMsgEv;

    const endEv = ctx.dispatchEvent({
      type: EventType.REASONING_END,
      messageId: msgId,
    } as BaseEvent);
    if (endEv) yield endEv;

    ctx.activeRun.reasoning_process = null;
  }
}
