import { EventType, type BaseEvent } from "@ag-ui/core";
import { AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { v4 as uuid } from "uuid";

import { contentToString } from "./langgraph-utils.js";

type ToolCallStreamState = {
  emittedId: string;
  name: string;
  args: string;
  started: boolean;
  ended: boolean;
};

type ToolCallChunkValue = NonNullable<AIMessageChunk["tool_call_chunks"]>[number];

type AIMessageStreamState = {
  messageId?: string;
  started: boolean;
  textClosed: boolean;
  finalChunk?: AIMessageChunk;
  fallbackToolCallIndex: number;
  toolCallStates: Map<string, ToolCallStreamState>;
};

function createAIMessageStreamState(): AIMessageStreamState {
  return {
    started: false,
    textClosed: false,
    fallbackToolCallIndex: 0,
    toolCallStates: new Map(),
  };
}

function appendChunk(state: AIMessageStreamState, chunk: AIMessageChunk) {
  state.finalChunk = state.finalChunk ? state.finalChunk.concat(chunk) : chunk;
  state.messageId ||= chunk.id || uuid();
}

function startTextIfNeeded(state: AIMessageStreamState): BaseEvent[] {
  if (!state.messageId) {
    return [];
  }

  const events: BaseEvent[] = [];

  if (!state.started) {
    state.started = true;
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: state.messageId,
      role: "assistant",
    } as BaseEvent);
  }

  if (state.textClosed) {
    events.push({
      type: EventType.TEXT_MESSAGE_START,
      messageId: state.messageId,
      role: "assistant",
    } as BaseEvent);
    state.textClosed = false;
  }

  return events;
}

function emitTextChunkEvents(
  state: AIMessageStreamState,
  textDelta: string,
): BaseEvent[] {
  if (!textDelta) {
    return [];
  }

  return [
    ...startTextIfNeeded(state),
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: state.messageId,
      delta: textDelta,
    } as BaseEvent,
  ];
}

function closeTextIfNeeded(state: AIMessageStreamState): BaseEvent[] {
  if (!state.started || state.textClosed || !state.messageId) {
    return [];
  }

  state.textClosed = true;

  return [
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: state.messageId,
    } as BaseEvent,
  ];
}

function resolveToolCallStateKey(
  state: AIMessageStreamState,
  toolCallChunk: ToolCallChunkValue,
) {
  if (typeof toolCallChunk.index === "number") {
    return `index:${toolCallChunk.index}`;
  }

  if (toolCallChunk.id) {
    return `id:${toolCallChunk.id}`;
  }

  return `fallback:${state.fallbackToolCallIndex++}`;
}

function getOrCreateToolCallState(
  state: AIMessageStreamState,
  toolCallChunk: ToolCallChunkValue,
) {
  const stateKey = resolveToolCallStateKey(state, toolCallChunk);
  const existingState = state.toolCallStates.get(stateKey);

  if (existingState) {
    return { stateKey, toolCallState: existingState };
  }

  return {
    stateKey,
    toolCallState: {
      emittedId: toolCallChunk.id || uuid(),
      name: toolCallChunk.name || "unknown_tool",
      args: "",
      started: false,
      ended: false,
    },
  };
}

function emitToolCallChunkEvents(
  state: AIMessageStreamState,
  toolCallChunk: ToolCallChunkValue,
): BaseEvent[] {
  const { stateKey, toolCallState } = getOrCreateToolCallState(
    state,
    toolCallChunk,
  );
  const toolCallId = toolCallState.emittedId;
  const events = [...closeTextIfNeeded(state)];

  if (toolCallChunk.name) {
    toolCallState.name = toolCallChunk.name;
  }

  if (toolCallChunk.id && toolCallState.emittedId !== toolCallChunk.id) {
    toolCallState.emittedId = toolCallChunk.id;
  }

  if (!toolCallState.started) {
    toolCallState.started = true;
    events.push({
      type: EventType.TOOL_CALL_START,
      parentMessageId: state.messageId,
      toolCallId,
      toolCallName: toolCallState.name,
    } as BaseEvent);
  }

  if (toolCallChunk.args) {
    toolCallState.args += toolCallChunk.args;
    events.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId,
      delta: toolCallChunk.args,
    } as BaseEvent);
  }

  state.toolCallStates.set(stateKey, toolCallState);
  return events;
}

function emitToolCallEndEvents(state: AIMessageStreamState): BaseEvent[] {
  if (!state.finalChunk) {
    return [];
  }

  const events: BaseEvent[] = [];

  for (const toolCall of state.finalChunk.tool_calls || []) {
    const toolCallId = toolCall.id || uuid();
    const toolCallState = Array.from(state.toolCallStates.values()).find(
      (item) => item.emittedId === toolCallId,
    );

    if (toolCallState && !toolCallState.ended) {
      toolCallState.ended = true;
      events.push({
        type: EventType.TOOL_CALL_END,
        toolCallId,
      } as BaseEvent);
    }
  }

  return events;
}

function emitFinalTextEndEvent(state: AIMessageStreamState): BaseEvent[] {
  if (!state.started || state.textClosed || !state.messageId) {
    return [];
  }

  return [
    {
      type: EventType.TEXT_MESSAGE_END,
      messageId: state.messageId,
    } as BaseEvent,
  ];
}

export async function* eventsFromAIMessageStream(
  stream: AsyncIterable<BaseMessage>,
): AsyncGenerator<BaseEvent, AIMessageChunk | undefined> {
  const state = createAIMessageStreamState();

  for await (const chunk of stream) {
    if (!(chunk instanceof AIMessageChunk)) {
      continue;
    }

    appendChunk(state, chunk);

    const textDelta = contentToString(chunk.content);
    for (const event of emitTextChunkEvents(state, textDelta)) {
      yield event;
    }

    for (const toolCallChunk of chunk.tool_call_chunks || []) {
      for (const event of emitToolCallChunkEvents(state, toolCallChunk)) {
        yield event;
      }
    }
  }

  for (const event of emitToolCallEndEvents(state)) {
    yield event;
  }

  for (const event of emitFinalTextEndEvent(state)) {
    yield event;
  }

  return state.finalChunk;
}
