import { EventType, type BaseEvent } from "@ag-ui/core";
import { v4 as uuid } from "uuid";

import type {
  LangGraphStreamEvent,
  RunMetadata,
  State,
} from "../types.js";
import { CustomEventNames, LangGraphEventTypes } from "../types.js";
import {
  contentToString,
  jsonSafeStringify,
  normalizeToolContent,
  resolveEncryptedReasoningContent,
  resolveMessageContent,
  resolveReasoningContent,
} from "../messages/convert.js";
import {
  chunkGet,
  getPredictStateTools,
  getToolCallChunks,
  hasPredictStateTool,
  isRecord,
} from "../events/guards.js";
import type { EventTranslatorContext } from "./context.js";
import {
  commandToolMessages,
  getEventDataRecord,
  isCommandLike,
  isToolMessageLike,
} from "./helpers.js";

export type { EventTranslatorContext } from "./context.js";

export async function* translateSingleEvent(
  event: LangGraphStreamEvent,
  ctx: EventTranslatorContext,
): AsyncGenerator<BaseEvent> {
  const eventType = event.event;
  const eventData = getEventDataRecord(event);
  const metadata = event.metadata ?? {};
  const runId = ctx.activeRun.id;

  if (eventType === LangGraphEventTypes.OnChatModelStream) {
    const shouldEmitMessages = metadata["emit-messages"] !== false;
    const shouldEmitToolCalls = metadata["emit-tool-calls"] !== false;

    const chunk = eventData.chunk;
    if (!chunk) return;

    const responseMeta =
      chunkGet<Record<string, unknown>>(chunk, "response_metadata") ?? {};
    const toolCallChunks = getToolCallChunks(chunk);

    if (responseMeta.finish_reason) return;

    const currentStream = ctx.getMessageInProgress(runId);
    const hasCurrentStream = Boolean(currentStream?.id);
    const hasToolCallChunks = toolCallChunks.length > 0;

    const predictStateMeta = getPredictStateTools(metadata);
    const toolCallUsedToPredictState =
      hasToolCallChunks &&
      toolCallChunks.some(
        (toolCallData) =>
          toolCallData.name && hasPredictStateTool(metadata, toolCallData.name),
      );

    if (hasToolCallChunks) {
      ctx.activeRun.has_function_streaming = true;
    }

    const chunkContent = chunkGet(chunk, "content");
    const chunkId = chunkGet<string>(chunk, "id") ?? uuid();

    const reasoningData = resolveReasoningContent(chunk);
    const encryptedReasoningData = resolveEncryptedReasoningContent(chunk);

    const messageContent =
      chunkContent !== null && chunkContent !== undefined
        ? resolveMessageContent(chunkContent)
        : null;

    const isMessageContentEvent =
      !hasToolCallChunks && messageContent !== null;
    const hasActiveToolCalls = Boolean(
      currentStream?.active_tool_calls &&
        Object.keys(currentStream.active_tool_calls).length > 0,
    );
    const hasTextStarted = currentStream?.text_started === true;
    const isMessageEndEvent =
      hasCurrentStream &&
      hasTextStarted &&
      !hasActiveToolCalls &&
      !isMessageContentEvent;

    if (reasoningData) {
      yield* ctx.handleReasoningEvent(
        reasoningData,
        null,
        currentStream?.id ?? chunkId,
      );
      return;
    }

    if (encryptedReasoningData && ctx.activeRun.reasoning_process) {
      yield* ctx.handleReasoningEvent(
        null,
        encryptedReasoningData,
        currentStream?.id ?? chunkId,
      );
      return;
    }

    if (!reasoningData && ctx.activeRun.reasoning_process) {
      yield* ctx.handleReasoningEvent(null, null, currentStream?.id ?? chunkId);
    }

    if (toolCallUsedToPredictState) {
      const ev = ctx.dispatchEvent({
        type: EventType.CUSTOM,
        name: "PredictState",
        value: predictStateMeta,
      } as BaseEvent);
      if (ev) yield ev;
    }

    if (isMessageEndEvent && currentStream) {
      const ev = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId: currentStream.id,
      } as BaseEvent);
      if (ev) yield ev;
      ctx.clearMessageInProgress(runId);
      return;
    }

    if (hasToolCallChunks && shouldEmitToolCalls) {
      const parentMessageId = currentStream?.id ?? chunkId;
      const toolCallInfoByIndex = {
        ...(currentStream?.tool_call_info_by_index ?? {}),
      };
      const activeToolCalls = {
        ...(currentStream?.active_tool_calls ?? {}),
      };

      for (const toolCallData of toolCallChunks) {
        const index = toolCallData.index ?? 0;
        const cachedToolCallInfo = toolCallInfoByIndex[index];
        const toolCallId = toolCallData.id ?? cachedToolCallInfo?.id ?? uuid();
        const toolCallName = toolCallData.name || cachedToolCallInfo?.name || null;

        if (toolCallName) {
          toolCallInfoByIndex[index] = {
            id: toolCallId,
            name: toolCallName,
          };
        }

        if (toolCallName && !activeToolCalls[toolCallId]) {
          const startEv = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName,
            parentMessageId,
          } as BaseEvent);
          if (startEv) yield startEv;
          ctx.activeRun.streamed_tool_call_ids?.add(toolCallId);
          activeToolCalls[toolCallId] = { name: toolCallName, index };
        }

        if (
          activeToolCalls[toolCallId] &&
          toolCallData.args !== undefined &&
          toolCallData.args !== null &&
          toolCallData.args !== ""
        ) {
          const argsEv = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta:
              typeof toolCallData.args === "string"
                ? toolCallData.args
                : JSON.stringify(toolCallData.args),
          } as BaseEvent);
          if (argsEv) yield argsEv;
        }
      }

      ctx.setMessageInProgress(runId, {
        id: parentMessageId,
        text_started: currentStream?.text_started === true,
        tool_call_id: null,
        tool_call_name: null,
        tool_call_info_by_index: toolCallInfoByIndex,
        active_tool_calls: activeToolCalls,
      });
      return;
    }

    if (isMessageContentEvent && shouldEmitMessages) {
      if (messageContent === "") return;

      if (!hasTextStarted) {
        const messageId = currentStream?.id ?? chunkId;
        const startEv = ctx.dispatchEvent({
          type: EventType.TEXT_MESSAGE_START,
          role: "assistant",
          messageId,
        } as BaseEvent);
        if (startEv) yield startEv;

        ctx.setMessageInProgress(runId, {
          id: messageId,
          text_started: true,
        });
      }

      const current = ctx.getMessageInProgress(runId);
      const contentEv = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: current?.id ?? currentStream?.id ?? chunkId,
        delta: messageContent,
      } as BaseEvent);
      if (contentEv) yield contentEv;
    }

    return;
  }

  if (eventType === LangGraphEventTypes.OnChatModelEnd) {
    const currentStream = ctx.getMessageInProgress(runId);
    const activeToolCalls = currentStream?.active_tool_calls ?? {};
    const activeToolCallIds = Object.keys(activeToolCalls);
    const hasTextStarted = currentStream?.text_started === true;
    const completedToolCalls = getToolCallChunks(eventData.output);
    const outputMessageId =
      chunkGet<string>(eventData.output, "id") ?? currentStream?.id ?? uuid();

    if (activeToolCallIds.length === 0 && completedToolCalls.length > 0) {
      let waitsForFrontendTool = false;

      for (const toolCallData of completedToolCalls) {
        const toolCallId = toolCallData.id ?? uuid();
        const toolCallName = toolCallData.name ?? "";

        const startEv = ctx.dispatchEvent({
          type: EventType.TOOL_CALL_START,
          toolCallId,
          toolCallName,
          parentMessageId: outputMessageId,
        } as BaseEvent);
        if (startEv) yield startEv;

        if (
          toolCallData.args !== undefined &&
          toolCallData.args !== null &&
          toolCallData.args !== ""
        ) {
          const argsEv = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta:
              typeof toolCallData.args === "string"
                ? toolCallData.args
                : JSON.stringify(toolCallData.args),
          } as BaseEvent);
          if (argsEv) yield argsEv;
        }

        const endEv = ctx.dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as BaseEvent);
        if (endEv) yield endEv;

        ctx.activeRun.streamed_tool_call_ids?.add(toolCallId);
        if (ctx.frontendToolNames.has(toolCallName)) {
          waitsForFrontendTool = true;
        }
      }

      if (waitsForFrontendTool) {
        ctx.activeRun.wait_for_frontend_tool = true;
      }
      ctx.clearMessageInProgress(runId);
      return;
    }

    if (activeToolCallIds.length > 0) {
      for (const toolCallId of activeToolCallIds) {
        const ev = ctx.dispatchEvent({
          type: EventType.TOOL_CALL_END,
          toolCallId,
        } as BaseEvent);
        if (ev) yield ev;
      }
      if (
        activeToolCallIds.some((toolCallId) =>
          ctx.frontendToolNames.has(activeToolCalls[toolCallId]?.name ?? ""),
        )
      ) {
        ctx.activeRun.wait_for_frontend_tool = true;
      }
      ctx.clearMessageInProgress(runId);
    } else if (currentStream?.id && hasTextStarted) {
      const ev = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId: currentStream.id,
      } as BaseEvent);
      if (ev) {
        ctx.clearMessageInProgress(runId);
        yield ev;
      }
    } else if (currentStream?.id) {
      ctx.clearMessageInProgress(runId);
    }
    return;
  }

  if (eventType === LangGraphEventTypes.OnCustomEvent) {
    const customName = event.name ?? "";
    const customData = event.data;
    const customRecord = isRecord(customData) ? customData : {};

    if (customName === CustomEventNames.ManuallyEmitMessage) {
      const msgId =
        typeof customRecord.message_id === "string"
          ? customRecord.message_id
          : uuid();
      let ev: BaseEvent | null;

      ev = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_START,
        role: "assistant",
        messageId: msgId,
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: msgId,
        delta: contentToString(
          customRecord.message ?? customRecord.content ?? customData,
        ),
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TEXT_MESSAGE_END,
        messageId: msgId,
      } as BaseEvent);
      if (ev) yield ev;
    } else if (customName === CustomEventNames.ManuallyEmitToolCall) {
      const tcId =
        typeof customRecord.id === "string" ? customRecord.id : uuid();
      let ev: BaseEvent | null;

      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_START,
        toolCallId: tcId,
        toolCallName:
          typeof customRecord.name === "string"
            ? customRecord.name
            : "unknown_tool",
        parentMessageId: tcId,
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: tcId,
        delta:
          typeof customRecord.args === "string"
            ? customRecord.args
            : JSON.stringify(customRecord.args ?? {}),
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_END,
        toolCallId: tcId,
      } as BaseEvent);
      if (ev) yield ev;
    } else if (customName === CustomEventNames.ManuallyEmitState) {
      ctx.activeRun.manually_emitted_state = isRecord(customData)
        ? customData
        : {};
      const ev = ctx.dispatchEvent({
        type: EventType.STATE_SNAPSHOT,
        snapshot: ctx.activeRun.manually_emitted_state,
      } as BaseEvent);
      if (ev) yield ev;
    }

    const customEv = ctx.dispatchEvent({
      type: EventType.CUSTOM,
      name: customName,
      value: customData,
    } as BaseEvent);
    if (customEv) yield customEv;

    return;
  }

  if (eventType === LangGraphEventTypes.OnToolEnd) {
    const toolCallOutput = eventData.output;
    if (!toolCallOutput) return;

    if (isCommandLike(toolCallOutput)) {
      for (const toolMsg of commandToolMessages(toolCallOutput)) {
        const toolCallId = toolMsg.tool_call_id;
        if (!toolCallId) continue;
        const toolCallName = toolMsg.name ?? event.name ?? "";

        if (!ctx.activeRun.streamed_tool_call_ids?.has(toolCallId)) {
          let ev: BaseEvent | null;
          ev = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_START,
            toolCallId,
            toolCallName,
            parentMessageId: toolMsg.id,
          } as BaseEvent);
          if (ev) yield ev;

          ev = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_ARGS,
            toolCallId,
            delta: jsonSafeStringify(eventData.input ?? {}),
          } as BaseEvent);
          if (ev) yield ev;

          ev = ctx.dispatchEvent({
            type: EventType.TOOL_CALL_END,
            toolCallId,
          } as BaseEvent);
          if (ev) yield ev;
        }

        if (ctx.frontendToolNames.has(toolCallName)) {
          ctx.activeRun.wait_for_frontend_tool = true;
          continue;
        }

        const resultEv = ctx.dispatchEvent({
          type: EventType.TOOL_CALL_RESULT,
          toolCallId,
          messageId: uuid(),
          content: normalizeToolContent(toolMsg.content),
          role: "tool",
        } as BaseEvent);
        if (resultEv) yield resultEv;
      }

      ctx.activeRun.model_made_tool_call = false;
      ctx.activeRun.state_reliable = true;
      ctx.activeRun.has_function_streaming = false;
      return;
    }

    if (!isToolMessageLike(toolCallOutput)) return;

    const toolCallId = toolCallOutput.tool_call_id;
    if (!toolCallId) return;
    const toolCallName = toolCallOutput.name ?? event.name ?? "";

    if (!ctx.activeRun.streamed_tool_call_ids?.has(toolCallId)) {
      let ev: BaseEvent | null;
      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_START,
        toolCallId,
        toolCallName,
        parentMessageId: toolCallOutput.id,
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_ARGS,
        toolCallId,
        delta: jsonSafeStringify(eventData.input ?? {}),
      } as BaseEvent);
      if (ev) yield ev;

      ev = ctx.dispatchEvent({
        type: EventType.TOOL_CALL_END,
        toolCallId,
      } as BaseEvent);
      if (ev) yield ev;
    }

    if (ctx.frontendToolNames.has(toolCallName)) {
      ctx.activeRun.model_made_tool_call = false;
      ctx.activeRun.state_reliable = true;
      ctx.activeRun.has_function_streaming = false;
      ctx.activeRun.wait_for_frontend_tool = true;
      return;
    }

    const resultEv = ctx.dispatchEvent({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId,
      messageId: uuid(),
      content: normalizeToolContent(toolCallOutput.content),
      role: "tool",
    } as BaseEvent);
    if (resultEv) yield resultEv;

    ctx.activeRun.model_made_tool_call = false;
    ctx.activeRun.state_reliable = true;
    ctx.activeRun.has_function_streaming = false;
    return;
  }

  if (eventType === LangGraphEventTypes.OnToolError) {
    ctx.activeRun.model_made_tool_call = false;
    ctx.activeRun.state_reliable = true;
    ctx.activeRun.has_function_streaming = false;
  }
}

export function markPredictStateToolIfNeeded(
  event: LangGraphStreamEvent,
  activeRun: RunMetadata,
): void {
  if (event.event !== LangGraphEventTypes.OnChatModelStream) return;
  const eventData = getEventDataRecord(event);
  const toolCallChunks = getToolCallChunks(
    isRecord(eventData) ? eventData.chunk : undefined,
  );
  const firstName = toolCallChunks[0]?.name;
  if (firstName && hasPredictStateTool(event.metadata ?? {}, firstName)) {
    activeRun.model_made_tool_call = true;
  }
}

export function mergeChainEndOutput(
  event: LangGraphStreamEvent,
  currentGraphState: State,
): { exitingNode: boolean; currentNodeName?: string } | null {
  if (event.event !== LangGraphEventTypes.OnChainEnd) return null;
  const eventData = getEventDataRecord(event);
  if (!isRecord(eventData.output)) return null;

  Object.assign(currentGraphState, eventData.output);
  const currentNodeName =
    typeof event.metadata?.langgraph_node === "string"
      ? event.metadata.langgraph_node
      : undefined;
  return { exitingNode: true, currentNodeName };
}
