import type {
  MessageInProgress,
  MessagesInProgressRecord,
} from "../types.js";

export function getMessageInProgress(
  messagesInProgress: MessagesInProgressRecord,
  runId: string,
): MessageInProgress | null {
  return messagesInProgress[runId] ?? null;
}

export function setMessageInProgress(
  messagesInProgress: MessagesInProgressRecord,
  runId: string,
  value: MessageInProgress | null,
): void {
  if (value === null) {
    messagesInProgress[runId] = null;
    return;
  }

  const current = messagesInProgress[runId] ?? {};
  messagesInProgress[runId] = {
    ...current,
    ...value,
  } as MessageInProgress;
}

export function clearMessageInProgress(
  messagesInProgress: MessagesInProgressRecord,
  runId: string,
): void {
  messagesInProgress[runId] = null;
}
