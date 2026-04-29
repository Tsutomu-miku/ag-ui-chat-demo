import type { RunAgentInput } from "@ag-ui/core";

import type { ForwardedProps, RunnableConfigLike } from "../types.js";
import { camelToSnake } from "../utils/convert.js";
import { isRecord } from "../events/guards.js";

export type NormalizedRunAgentInput = RunAgentInput & {
  forwarded_props?: ForwardedProps;
};

export function normalizeForwardedProps(input: RunAgentInput): ForwardedProps {
  const inputRecord = input as unknown as Record<string, unknown>;
  const raw =
    (isRecord(inputRecord.forwardedProps)
      ? inputRecord.forwardedProps
      : undefined) ??
    (isRecord(inputRecord.forwarded_props)
      ? inputRecord.forwarded_props
      : undefined) ??
    {};

  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [camelToSnake(key), value]),
  ) as ForwardedProps;
}

export function normalizeRunInput(
  input: RunAgentInput,
): NormalizedRunAgentInput {
  return {
    ...input,
    forwarded_props: normalizeForwardedProps(input),
  };
}

export function buildRunConfig(
  baseConfig: Record<string, unknown>,
  threadId: string,
): RunnableConfigLike {
  const configurable = isRecord(baseConfig.configurable)
    ? baseConfig.configurable
    : {};

  return {
    ...baseConfig,
    configurable: {
      ...configurable,
      thread_id: threadId,
    },
  };
}
