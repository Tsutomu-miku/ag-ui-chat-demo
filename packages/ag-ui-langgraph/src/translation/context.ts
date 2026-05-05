import type { BaseEvent } from "@ag-ui/core";

import type {
  LangGraphReasoning,
  MessageInProgress,
  RunMetadata,
} from "../types.js";

export type DispatchEvent = (event: BaseEvent) => BaseEvent | null;

export type EventTranslatorContext = {
  activeRun: RunMetadata;
  frontendToolNames: Set<string>;
  getMessageInProgress: (runId: string) => MessageInProgress | null;
  setMessageInProgress: (
    runId: string,
    value: MessageInProgress | null,
  ) => void;
  clearMessageInProgress: (runId: string) => void;
  dispatchEvent: DispatchEvent;
  handleReasoningEvent: (
    reasoningData: LangGraphReasoning | null,
    encryptedData: string | null,
    parentMessageId?: string | null,
  ) => Generator<BaseEvent>;
};
