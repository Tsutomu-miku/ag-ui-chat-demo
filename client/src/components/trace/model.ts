import type {
  ActiveStep,
  AgUiTraceEvent,
  ChatMessage,
  ExecutionOwner,
  ToolCallFunction,
  TraceEvent,
} from "ag-ui-react";
import { AG_UI_TRACE_EVENT_NAME } from "ag-ui-react";

export type TraceMode = "none" | "timeline" | "agent";

export interface TurnPresentation {
  traceMode: TraceMode;
  standaloneMessages: ChatMessage[];
}

export interface AgentTraceNode {
  stepId: string;
  stepName: string;
  stepKind?: string;
  parentStepId?: string;
  parentStepName?: string;
  owner?: ExecutionOwner;
  active?: boolean;
  order?: number;
  messageOrders: Record<string, number>;
  toolOrders: Record<string, number>;
  childStepIds: string[];
  messages: ChatMessage[];
  toolCalls: ToolCallFunction[];
  renderItems: AgentTraceRenderItem[];
}

export type AgentTraceRenderItem =
  | { type: "message"; messageId: string }
  | { type: "tool"; toolCallId: string }
  | { type: "child"; stepId: string };

export interface AgentTraceData {
  roots: string[];
  nodes: Record<string, AgentTraceNode>;
}

export interface TimelineTraceEntry {
  messageId: string;
  toolCall: ToolCallFunction;
}

export interface ToolInputDisplay {
  content: string;
  isStreaming: boolean;
}

export interface ToolResultDisplay {
  content: string;
  isStreaming: boolean;
}

export const AGENT_LABELS: Record<
  string,
  { label: string; badge: string; role: string }
> = {
  supervisor: { label: "Supervisor", badge: "SV", role: "Coordinator" },
  researcher: { label: "Researcher", badge: "RS", role: "Sub-agent" },
  weather_researcher: {
    label: "Weather Researcher",
    badge: "RS",
    role: "Weather specialist",
  },
  travel_guidance_researcher: {
    label: "Travel Researcher",
    badge: "RS",
    role: "Travel guidance",
  },
  writer: { label: "Writer", badge: "WR", role: "Sub-agent" },
};

export const TOOL_LABELS: Record<string, { label: string; type: string }> = {
  get_weather: { label: "Weather Lookup", type: "backend" },
  search_web: { label: "Web Search", type: "backend" },
  calculate: { label: "Calculator", type: "backend" },
  compose_text: { label: "Draft Writer", type: "backend" },
  tool_result: { label: "Tool Result", type: "backend" },
  get_current_time: { label: "Current Time", type: "backend" },
  confirm_action: { label: "Confirm Action", type: "frontend" },
  collect_user_input: { label: "User Input", type: "frontend" },
  delegate_to_subagent: { label: "Delegate", type: "delegation" },
  transfer_to_researcher: { label: "Handoff", type: "delegation" },
  transfer_to_weather_researcher: { label: "Handoff", type: "delegation" },
  transfer_to_travel_guidance_researcher: {
    label: "Handoff",
    type: "delegation",
  },
  transfer_to_writer: { label: "Handoff", type: "delegation" },
  forward_message: { label: "Forward Message", type: "delegation" },
};

function parseToolArgs(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getCanonicalTraceValue(event: TraceEvent): AgUiTraceEvent | null {
  if (event.type !== "CUSTOM" || event.name !== AG_UI_TRACE_EVENT_NAME) {
    return null;
  }
  if (!isRecord(event.value) || typeof event.value.type !== "string") {
    return null;
  }

  switch (event.value.type) {
    case "span.start":
      return typeof event.value.spanId === "string" &&
        typeof event.value.name === "string" &&
        typeof event.value.kind === "string"
        ? (event.value as AgUiTraceEvent)
        : null;
    case "span.end":
      return typeof event.value.spanId === "string"
        ? (event.value as AgUiTraceEvent)
        : null;
    case "message.link":
      return typeof event.value.spanId === "string" &&
        typeof event.value.messageId === "string"
        ? (event.value as AgUiTraceEvent)
        : null;
    case "tool.link":
      return typeof event.value.spanId === "string" &&
        typeof event.value.toolCallId === "string"
        ? (event.value as AgUiTraceEvent)
        : null;
    default:
      return null;
  }
}

function getCheckpointNamespaceRoot(
  traceValue: AgUiTraceEvent,
): string | undefined {
  const source = isRecord((traceValue as { source?: unknown }).source)
    ? ((traceValue as { source?: unknown }).source as Record<string, unknown>)
    : undefined;
  const checkpointNamespace =
    typeof source?.checkpointNamespace === "string"
      ? source.checkpointNamespace
      : undefined;
  return checkpointNamespace?.split("|")[0];
}

function getTraceOwner(traceValue: AgUiTraceEvent) {
  if (!("owner" in traceValue) || !isRecord(traceValue.owner)) {
    return undefined;
  }
  const owner = traceValue.owner;
  if (
    typeof owner.key !== "string" ||
    typeof owner.type !== "string" ||
    typeof owner.instanceId !== "string"
  ) {
    return undefined;
  }
  return {
    key: owner.key,
    type: owner.type,
    instanceId: owner.instanceId,
    ...(typeof owner.parentKey === "string"
      ? { parentKey: owner.parentKey }
      : {}),
  } satisfies ExecutionOwner;
}

function getLogicalOwnerNodeId(owner?: ExecutionOwner): string | undefined {
  if (owner?.type && owner.instanceId) {
    return `${owner.type}:${owner.instanceId}`;
  }
  return owner?.instanceId || owner?.key;
}

function getLogicalOwnerNodeIdFromKey(ownerKey?: string): string | undefined {
  if (!ownerKey) return undefined;
  const segments = ownerKey.split(":");
  return segments.length >= 3 ? segments.slice(1).join(":") : ownerKey;
}

function getLogicalTraceOwnerId(
  traceValue: AgUiTraceEvent,
): string | undefined {
  const owner = getTraceOwner(traceValue);
  return getLogicalOwnerNodeId(owner);
}

function getLogicalTraceParentOwnerId(
  traceValue: AgUiTraceEvent,
): string | undefined {
  const owner = getTraceOwner(traceValue);
  return owner?.parentKey
    ? getLogicalOwnerNodeIdFromKey(owner.parentKey)
    : undefined;
}

function hasCanonicalTrace(traceEvents: TraceEvent[]) {
  return traceEvents.some((event) => getCanonicalTraceValue(event) !== null);
}

function normalizeStepName(stepName?: string): string | undefined {
  return stepName && stepName.trim() ? stepName : undefined;
}

function normalizeStepId(
  stepId?: string,
  stepName?: string,
): string | undefined {
  return stepId || normalizeStepName(stepName);
}

function normalizeContent(content: string): string {
  return content.trim().toLowerCase();
}

export function isSupervisorWrapUpText(content: string): boolean {
  const normalized = normalizeContent(content);
  return (
    normalized.startsWith("perfect!") ||
    normalized.startsWith("i've completed") ||
    normalized.startsWith("i have completed") ||
    normalized.includes("completed your request")
  );
}

function isAgentStep(opts: {
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
}): boolean {
  return Boolean(
    opts.stepKind === "supervisor" ||
    opts.stepKind === "subagent" ||
    opts.parentStepId ||
    opts.parentStepName,
  );
}

function hasStructuredAgentIdentity(opts: {
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
}): boolean {
  return Boolean(
    opts.stepKind === "supervisor" ||
    opts.stepKind === "subagent" ||
    opts.parentStepId ||
    opts.parentStepName,
  );
}

export function getAgentInfo(stepName: string) {
  return (
    AGENT_LABELS[stepName] || {
      label: stepName,
      badge: stepName.slice(0, 2).toUpperCase(),
      role: "Agent",
    }
  );
}

export function getToolInfo(name: string) {
  return TOOL_LABELS[name] || { label: name, type: "backend" };
}

export function formatJSON(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export function isDelegationTool(name: string): boolean {
  return (
    name === "delegate_to_subagent" ||
    name === "forward_message" ||
    name.startsWith("transfer_to_")
  );
}

export function isInternalDelegationTool(name: string): boolean {
  return name === "transfer_back_to_supervisor";
}

export function getDelegatedAgent(
  toolCall: Pick<ToolCallFunction, "function">,
): string | undefined {
  const transferMatch = /^transfer_to_(.+)$/.exec(toolCall.function.name);
  if (transferMatch) return transferMatch[1];

  const args = parseToolArgs(toolCall.function.arguments);
  for (const key of ["agent", "subagent", "recipient", "target", "name"]) {
    const value = args[key];
    if (typeof value === "string") {
      return value.replace(/^transfer_to_/, "");
    }
  }

  return undefined;
}

export function getDelegationInput(
  toolCall: Pick<ToolCallFunction, "function">,
): string | undefined {
  const args = toolCall.function.arguments;
  if (!args || args.trim() === "{}") return undefined;

  const parsedArgs = parseToolArgs(args);
  const rawInput =
    typeof parsedArgs.input === "string" ? parsedArgs.input.trim() : undefined;
  if (rawInput) {
    if (rawInput === "{}") return undefined;
    const nestedArgs = parseToolArgs(rawInput);
    const nestedInput =
      typeof nestedArgs.input === "string"
        ? nestedArgs.input.trim()
        : undefined;
    if (nestedInput && nestedInput !== "{}") {
      return nestedInput;
    }
    return rawInput;
  }

  return args.trim() === '{"input":"{}"}' ? undefined : args;
}

export function getToolInputDisplay(
  toolCall: Pick<ToolCallFunction, "function" | "complete">,
): ToolInputDisplay | undefined {
  const args = toolCall.function.arguments;
  if (!args) return undefined;

  return {
    content: toolCall.complete ? formatJSON(args) : args,
    isStreaming: !toolCall.complete,
  };
}

export function getToolResultDisplay(
  result: Pick<ChatMessage, "content" | "isStreaming">,
): ToolResultDisplay | undefined {
  if (!result.content) return undefined;

  return {
    content: result.isStreaming ? result.content : formatJSON(result.content),
    isStreaming: Boolean(result.isStreaming),
  };
}

function collectAssistantMessages(messages: ChatMessage[]) {
  return messages.filter(
    (message) =>
      message.role === "assistant" && message.content.trim().length > 0,
  );
}

function collectToolCalls(messages: ChatMessage[]) {
  return messages.flatMap((message) => message.toolCalls ?? []);
}

export function getTraceMode(
  messages: ChatMessage[],
  activeSteps: ActiveStep[],
  traceEvents: TraceEvent[] = [],
): TraceMode {
  const toolCalls = collectToolCalls(messages);
  const hasToolActivity =
    toolCalls.length > 0 || messages.some((message) => message.role === "tool");
  const hasStructuredAgentTrace =
    hasCanonicalTrace(traceEvents) ||
    traceEvents.some((event) => {
      const step = event.step;
      return hasStructuredAgentIdentity({
        stepId: step?.id,
        parentStepId: step?.parentId,
        stepKind: step?.kind,
        stepName: step?.name,
      });
    }) ||
    messages.some((message) => {
      const step = message.step;
      return hasStructuredAgentIdentity({
        stepId: step?.id,
        parentStepId: step?.parentId,
        stepKind: step?.kind,
        stepName: step?.name,
      });
    }) ||
    activeSteps.some((activeStep) =>
      hasStructuredAgentIdentity({
        stepId: activeStep.step?.id,
        parentStepId: activeStep.step?.parentId,
        stepKind: activeStep.step?.kind,
        stepName: activeStep.stepName,
      }),
    );

  if (hasStructuredAgentTrace) {
    return "agent";
  }

  if (hasToolActivity || activeSteps.length > 0) {
    return "timeline";
  }

  return "none";
}

export function buildTurnPresentation(
  messages: ChatMessage[],
  activeSteps: ActiveStep[],
  traceEvents: TraceEvent[] = [],
): TurnPresentation {
  const traceMode = getTraceMode(messages, activeSteps, traceEvents);
  const assistantMessages = collectAssistantMessages(messages);

  return {
    traceMode,
    standaloneMessages: traceMode === "agent" ? [] : assistantMessages,
  };
}

export function getMessageSourceLabel(
  message: ChatMessage,
): string | undefined {
  if (message.role !== "assistant") return undefined;
  const stepName = normalizeStepName(message.step?.name);
  if (
    !stepName ||
    stepName === "supervisor" ||
    !(message.step?.kind === "subagent" || message.step?.parentId)
  ) {
    return undefined;
  }

  return getAgentInfo(stepName).label;
}

export function buildToolResultMap(messages: ChatMessage[]) {
  return new Map(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => [
        message.toolCallId as string,
        {
          content: message.content,
          isStreaming: Boolean(message.isStreaming),
        } satisfies ToolResultDisplay,
      ]),
  );
}

function getNodeOrder(node: AgentTraceNode): number {
  const messageOrders = Object.values(node.messageOrders);
  const toolOrders = Object.values(node.toolOrders);
  const earliestLinkedOrder =
    messageOrders.length > 0 || toolOrders.length > 0
      ? Math.min(...messageOrders, ...toolOrders)
      : undefined;

  return node.order ?? earliestLinkedOrder ?? Number.MAX_SAFE_INTEGER;
}

export function buildTimelineTraceEntries(
  messages: ChatMessage[],
): TimelineTraceEntry[] {
  return messages.flatMap((message) =>
    (message.toolCalls ?? []).map((toolCall) => ({
      messageId: message.id,
      toolCall,
    })),
  );
}

function ensureTraceNode(
  nodes: Record<string, AgentTraceNode>,
  stepId: string,
  stepName: string,
  stepKind?: string,
  parentStepId?: string,
  parentStepName?: string,
  order?: number,
  owner?: ExecutionOwner,
) {
  const existing = nodes[stepId];
  if (existing) {
    if (existing.stepName === existing.stepId && stepName !== stepId) {
      existing.stepName = stepName;
    }
    existing.stepKind ||= stepKind;
    existing.parentStepId ||= parentStepId;
    existing.parentStepName ||= parentStepName;
    if (
      order !== undefined &&
      (existing.order === undefined || order < existing.order)
    ) {
      existing.order = order;
    }
    existing.owner ||= owner;
    return existing;
  }

  const created: AgentTraceNode = {
    stepId,
    stepName,
    ...(stepKind ? { stepKind } : {}),
    ...(parentStepId ? { parentStepId } : {}),
    ...(parentStepName ? { parentStepName } : {}),
    ...(owner ? { owner } : {}),
    ...(order !== undefined ? { order } : {}),
    messageOrders: {},
    toolOrders: {},
    childStepIds: [],
    messages: [],
    toolCalls: [],
    renderItems: [],
  };
  nodes[stepId] = created;
  return created;
}

function pushTraceRenderItem(node: AgentTraceNode, item: AgentTraceRenderItem) {
  const exists = node.renderItems.some((existing) => {
    if (existing.type !== item.type) return false;
    if (item.type === "message") {
      return (
        existing.type === "message" && existing.messageId === item.messageId
      );
    }
    if (item.type === "tool") {
      return (
        existing.type === "tool" && existing.toolCallId === item.toolCallId
      );
    }
    return existing.type === "child" && existing.stepId === item.stepId;
  });

  if (!exists) {
    node.renderItems.push(item);
  }
}

function pushChildRenderItem(
  nodes: Record<string, AgentTraceNode>,
  parentStepId: string | undefined,
  childStepId: string,
) {
  if (!parentStepId) return;
  const parent = nodes[parentStepId];
  if (!parent) return;
  pushTraceRenderItem(parent, { type: "child", stepId: childStepId });
}

function linkParent(
  nodes: Record<string, AgentTraceNode>,
  parentStepId: string,
  childStepId: string,
) {
  if (parentStepId === childStepId) return;

  const parent = nodes[parentStepId];
  const child = nodes[childStepId];
  if (!parent || !child) return;

  child.parentStepId ||= parentStepId;
  child.parentStepName ||= parent.stepName;
  if (!parent.childStepIds.includes(childStepId)) {
    parent.childStepIds.push(childStepId);
  }
}

function collectStepIdsFromMessages(messages: ChatMessage[]) {
  const stepIds = new Set<string>();

  for (const message of messages) {
    const stepId = normalizeStepId(message.step?.id, message.step?.name);
    if (stepId) stepIds.add(stepId);
    if (message.step?.parentId) stepIds.add(message.step.parentId);
    for (const toolCall of message.toolCalls ?? []) {
      const toolStepId = normalizeStepId(
        toolCall.step?.id,
        toolCall.step?.name,
      );
      if (toolStepId) stepIds.add(toolStepId);
      if (toolCall.step?.parentId) stepIds.add(toolCall.step.parentId);
    }
  }

  return stepIds;
}

export function filterTraceEventsForTurn(
  traceEvents: TraceEvent[],
  messages: ChatMessage[],
  includeUnlinkedCanonicalTrace = false,
): TraceEvent[] {
  if (traceEvents.length === 0) return [];

  if (includeUnlinkedCanonicalTrace && messages.length === 0) {
    const lastRunStartIndex = traceEvents.reduce(
      (latest, event, index) => (event.type === "RUN_STARTED" ? index : latest),
      -1,
    );
    return traceEvents
      .slice(lastRunStartIndex + 1)
      .filter(
        (event) =>
          event.type !== "RUN_STARTED" &&
          event.type !== "RUN_FINISHED" &&
          getCanonicalTraceValue(event) !== null,
      );
  }

  const messageIds = new Set(messages.map((message) => message.id));
  const toolCallIds = new Set(
    messages.flatMap((message) => [
      ...(message.toolCallId ? [message.toolCallId] : []),
      ...(message.toolCalls ?? []).map((toolCall) => toolCall.id),
    ]),
  );
  const stepIds = collectStepIdsFromMessages(messages);
  const selected = new Set<number>();

  for (let index = 0; index < traceEvents.length; index++) {
    const event = traceEvents[index]!;
    const traceValue = getCanonicalTraceValue(event);

    if (
      traceValue?.type === "message.link" &&
      messageIds.has(traceValue.messageId)
    ) {
      selected.add(index);
      stepIds.add(traceValue.spanId);
      continue;
    }

    if (
      traceValue?.type === "tool.link" &&
      toolCallIds.has(traceValue.toolCallId)
    ) {
      selected.add(index);
      stepIds.add(traceValue.spanId);
      continue;
    }

    if (
      (event.messageId && messageIds.has(event.messageId)) ||
      (event.parentMessageId && messageIds.has(event.parentMessageId)) ||
      (event.toolCallId && toolCallIds.has(event.toolCallId))
    ) {
      selected.add(index);
      if (event.step?.id) stepIds.add(event.step.id);
      if (event.step?.parentId) stepIds.add(event.step.parentId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < traceEvents.length; index++) {
      if (selected.has(index)) continue;
      const event = traceEvents[index]!;
      const traceValue = getCanonicalTraceValue(event);
      const traceStepId =
        traceValue?.type === "span.start" ||
        traceValue?.type === "span.end" ||
        traceValue?.type === "message.link" ||
        traceValue?.type === "tool.link"
          ? traceValue.spanId
          : undefined;
      const traceParentStepId =
        traceValue?.type === "span.start" ? traceValue.parentSpanId : undefined;

      if (
        (traceStepId && stepIds.has(traceStepId)) ||
        (traceParentStepId && stepIds.has(traceParentStepId))
      ) {
        selected.add(index);
        if (traceStepId) stepIds.add(traceStepId);
        if (traceParentStepId) stepIds.add(traceParentStepId);
        changed = true;
        continue;
      }

      if (
        (event.step?.id && stepIds.has(event.step.id)) ||
        (event.step?.parentId && stepIds.has(event.step.parentId))
      ) {
        selected.add(index);
        if (event.step?.id) stepIds.add(event.step.id);
        if (event.step?.parentId) stepIds.add(event.step.parentId);
        changed = true;
      }
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => traceEvents[index]!)
    .filter(
      (event) => event.type !== "RUN_STARTED" && event.type !== "RUN_FINISHED",
    );
}

function buildStructuredAgentTraceData(
  messages: ChatMessage[],
  activeSteps: ActiveStep[],
  traceEvents: TraceEvent[],
): AgentTraceData | null {
  const nodes: Record<string, AgentTraceNode> = {};

  for (const [eventIndex, event] of traceEvents.entries()) {
    const step = event.step;
    const stepId = normalizeStepId(step?.id, step?.name);
    const parentStepId = normalizeStepId(step?.parentId);
    if (
      !stepId ||
      !isAgentStep({
        stepId,
        parentStepId,
        stepKind: step?.kind,
        stepName: step?.name,
      })
    ) {
      continue;
    }

    ensureTraceNode(
      nodes,
      stepId,
      step?.name ?? stepId,
      step?.kind,
      parentStepId,
      parentStepId ? nodes[parentStepId]?.stepName : undefined,
      eventIndex,
    );

    if (parentStepId) {
      ensureTraceNode(
        nodes,
        parentStepId,
        parentStepId,
        step?.parentId ? undefined : "supervisor",
        undefined,
        undefined,
        eventIndex,
      );
      linkParent(nodes, parentStepId, stepId);
    }
  }

  const activeStepOrderOffset = traceEvents.length;
  for (const [stepIndex, step] of activeSteps.entries()) {
    const stepRef = step.step;
    const stepId = normalizeStepId(stepRef?.id, step.stepName);
    const parentStepId = normalizeStepId(stepRef?.parentId);
    if (
      !stepId ||
      !isAgentStep({
        stepId,
        parentStepId,
        stepKind: stepRef?.kind,
        stepName: step.stepName,
      })
    ) {
      continue;
    }

    ensureTraceNode(
      nodes,
      stepId,
      step.stepName,
      stepRef?.kind,
      parentStepId,
      parentStepId ? nodes[parentStepId]?.stepName : undefined,
      activeStepOrderOffset + stepIndex,
    );
    if (parentStepId) {
      ensureTraceNode(
        nodes,
        parentStepId,
        parentStepId,
        "supervisor",
        undefined,
        undefined,
        activeStepOrderOffset + stepIndex,
      );
      linkParent(nodes, parentStepId, stepId);
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    const resolvedStepId = message.step?.id;
    const resolvedParentStepId = message.step?.parentId;
    if (
      resolvedStepId &&
      hasStructuredAgentIdentity({
        stepId: message.step?.id,
        parentStepId: message.step?.parentId,
        stepKind: message.step?.kind,
        stepName: message.step?.name,
      })
    ) {
      const node = ensureTraceNode(
        nodes,
        resolvedStepId,
        message.step?.name ?? resolvedStepId,
        message.step?.kind,
        resolvedParentStepId,
        resolvedParentStepId
          ? nodes[resolvedParentStepId]?.stepName
          : undefined,
        messageIndex,
      );
      node.messages.push(message);
      node.messageOrders[message.id] = messageIndex;
      if (message.role !== "tool") {
        pushTraceRenderItem(node, { type: "message", messageId: message.id });
        for (const toolCall of message.toolCalls ?? []) {
          node.toolOrders[toolCall.id] = messageIndex + 0.01;
        }
      }
      if (resolvedParentStepId) {
        ensureTraceNode(
          nodes,
          resolvedParentStepId,
          resolvedParentStepId,
          "supervisor",
          undefined,
          undefined,
          messageIndex,
        );
        linkParent(nodes, resolvedParentStepId, resolvedStepId);
        pushChildRenderItem(nodes, resolvedParentStepId, resolvedStepId);
      }
    }
  }

  if (Object.keys(nodes).length === 0) {
    return null;
  }

  const roots = Object.values(nodes)
    .filter((node) => !node.parentStepId || !nodes[node.parentStepId])
    .sort((left, right) => {
      const orderDelta = getNodeOrder(left) - getNodeOrder(right);
      if (orderDelta !== 0) return orderDelta;
      if (left.stepName === "supervisor" && right.stepName !== "supervisor") {
        return -1;
      }
      if (right.stepName === "supervisor" && left.stepName !== "supervisor") {
        return 1;
      }
      return left.stepName.localeCompare(right.stepName);
    })
    .map((node) => node.stepId);

  return { roots, nodes };
}

function buildCanonicalAgentTraceData(
  messages: ChatMessage[],
  traceEvents: TraceEvent[],
): AgentTraceData | null {
  const nodes: Record<string, AgentTraceNode> = {};
  const spanAliases = new Map<string, string>();
  const logicalSpanIds = new Map<string, string>();
  const messageSpanIds = new Map<string, string>();
  const toolSpanIds = new Map<
    string,
    {
      spanId: string;
      traceOrder: number;
      toolCallName?: string;
      parentMessageId?: string;
    }
  >();

  const resolveSpanId = (spanId: string) => spanAliases.get(spanId) ?? spanId;

  for (const [eventIndex, event] of traceEvents.entries()) {
    const traceValue = getCanonicalTraceValue(event);
    if (!traceValue) continue;

    if (traceValue.type === "span.start") {
      const traceOwner = getTraceOwner(traceValue);
      const namespaceRoot = getCheckpointNamespaceRoot(traceValue);
      const resolvedParentSpanId = traceValue.parentSpanId
        ? resolveSpanId(traceValue.parentSpanId)
        : undefined;
      let spanId: string;
      let parentSpanId: string | undefined;
      let stepName = traceValue.name;
      let ownerMeta: ExecutionOwner | undefined;

      const logicalOwnerId = getLogicalTraceOwnerId(traceValue);
      const logicalParentOwnerId = getLogicalTraceParentOwnerId(traceValue);

      if (traceOwner?.key && logicalOwnerId) {
        spanId = logicalOwnerId;
        parentSpanId = logicalParentOwnerId ?? resolvedParentSpanId;
        stepName = traceOwner.type;
        ownerMeta = traceOwner;
        spanAliases.set(traceValue.spanId, spanId);
      } else {
        const logicalSpanKey =
          namespaceRoot &&
          !(traceValue.kind === "supervisor" && !resolvedParentSpanId)
            ? [
                traceValue.kind,
                traceValue.name,
                resolvedParentSpanId ?? "root",
                namespaceRoot,
              ].join("|")
            : undefined;
        const existingSupervisorRoot =
          traceValue.kind === "supervisor" && !resolvedParentSpanId
            ? Object.values(nodes).find(
                (node) =>
                  node.stepKind === "supervisor" &&
                  !node.parentStepId &&
                  node.stepName === traceValue.name,
              )
            : undefined;
        const existingLogicalSpanId = logicalSpanKey
          ? logicalSpanIds.get(logicalSpanKey)
          : undefined;
        spanId =
          existingSupervisorRoot?.stepId ??
          existingLogicalSpanId ??
          traceValue.spanId;
        if (existingSupervisorRoot) {
          spanAliases.set(traceValue.spanId, existingSupervisorRoot.stepId);
        }
        if (existingLogicalSpanId) {
          spanAliases.set(traceValue.spanId, existingLogicalSpanId);
        }
        if (logicalSpanKey && !existingLogicalSpanId) {
          logicalSpanIds.set(logicalSpanKey, spanId);
        }
        parentSpanId = resolvedParentSpanId;
      }
      const node = ensureTraceNode(
        nodes,
        spanId,
        stepName,
        traceValue.kind,
        parentSpanId,
        parentSpanId ? nodes[parentSpanId]?.stepName : undefined,
        eventIndex,
        ownerMeta,
      );
      node.active = true;

      if (parentSpanId) {
        ensureTraceNode(
          nodes,
          parentSpanId,
          parentSpanId,
          undefined,
          undefined,
          undefined,
          eventIndex,
        );
        linkParent(nodes, parentSpanId, spanId);
      }
    }

    if (traceValue.type === "span.end") {
      const node = nodes[resolveSpanId(traceValue.spanId)];
      if (node) node.active = false;
    }

    if (traceValue.type === "message.link") {
      messageSpanIds.set(
        traceValue.messageId,
        getLogicalTraceOwnerId(traceValue) ?? resolveSpanId(traceValue.spanId),
      );
    }

    if (traceValue.type === "tool.link") {
      toolSpanIds.set(traceValue.toolCallId, {
        spanId:
          getLogicalTraceOwnerId(traceValue) ??
          resolveSpanId(traceValue.spanId),
        traceOrder: eventIndex,
        ...(traceValue.toolCallName
          ? { toolCallName: traceValue.toolCallName }
          : {}),
        ...(traceValue.parentMessageId
          ? { parentMessageId: traceValue.parentMessageId }
          : {}),
      });
      if (
        traceValue.parentMessageId &&
        !messageSpanIds.has(traceValue.parentMessageId)
      ) {
        messageSpanIds.set(
          traceValue.parentMessageId,
          getLogicalTraceOwnerId(traceValue) ??
            resolveSpanId(traceValue.spanId),
        );
      }
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    let spanId =
      getLogicalOwnerNodeId(message.owner) ?? messageSpanIds.get(message.id);
    if (!spanId && message.role === "assistant") {
      spanId = (message.toolCalls ?? [])
        .map(
          (toolCall) =>
            getLogicalOwnerNodeId(toolCall.owner) ??
            toolSpanIds.get(toolCall.id)?.spanId,
        )
        .find((item): item is string => Boolean(item));
    }
    if (!spanId && message.role === "tool" && message.toolCallId) {
      spanId =
        getLogicalOwnerNodeId(message.owner) ??
        toolSpanIds.get(message.toolCallId)?.spanId;
    }

    if (spanId && nodes[spanId]) {
      const node = nodes[spanId]!;
      node.owner ||= message.owner;
      node.messages.push(message);
      node.messageOrders[message.id] = messageIndex;
      if (node.order === undefined || messageIndex < node.order) {
        node.order = messageIndex;
      }
      if (message.role === "tool" && message.toolCallId) {
        pushTraceRenderItem(node, {
          type: "tool",
          toolCallId: message.toolCallId,
        });
      } else {
        pushTraceRenderItem(node, { type: "message", messageId: message.id });
      }
      pushChildRenderItem(nodes, node.parentStepId, node.stepId);
    }

    for (const toolCall of message.toolCalls ?? []) {
      const logicalToolOwnerId = getLogicalOwnerNodeId(toolCall.owner);
      const owner = logicalToolOwnerId
        ? {
            spanId: logicalToolOwnerId,
            traceOrder: messageIndex,
            toolCallName: toolCall.function.name,
          }
        : toolSpanIds.get(toolCall.id);
      const ownerNode = owner ? nodes[owner.spanId] : undefined;
      if (
        ownerNode &&
        !ownerNode.toolCalls.some((item) => item.id === toolCall.id)
      ) {
        ownerNode.toolCalls.push({
          ...toolCall,
          ...(toolCall.owner || ownerNode.owner
            ? { owner: toolCall.owner ?? ownerNode.owner }
            : {}),
        });
      }
      if (ownerNode) {
        ownerNode.toolOrders[toolCall.id] =
          nodes[spanId ?? ""]?.messageOrders[message.id] ?? messageIndex + 0.01;
      }
    }
  }

  for (const [toolCallId, owner] of toolSpanIds) {
    const node = nodes[owner.spanId];
    if (
      !node ||
      node.toolCalls.some((toolCall) => toolCall.id === toolCallId)
    ) {
      continue;
    }

    const resultMessage = messages.find(
      (message) => message.role === "tool" && message.toolCallId === toolCallId,
    );
    const resultMessageIndex = resultMessage
      ? messages.indexOf(resultMessage)
      : -1;

    node.toolCalls.push({
      id: toolCallId,
      type: "function",
      function: {
        name: owner.toolCallName ?? "tool_result",
        arguments: "",
      },
      complete: Boolean(resultMessage),
      ...(node.owner ? { owner: node.owner } : {}),
    });
    node.toolOrders[toolCallId] =
      resultMessageIndex >= 0 ? resultMessageIndex : owner.traceOrder;
    if (resultMessageIndex < 0) {
      pushTraceRenderItem(node, { type: "tool", toolCallId });
    }
  }

  if (Object.keys(nodes).length === 0) {
    return null;
  }

  const roots = Object.values(nodes)
    .filter((node) => !node.parentStepId || !nodes[node.parentStepId])
    .sort((left, right) => {
      const orderDelta = getNodeOrder(left) - getNodeOrder(right);
      if (orderDelta !== 0) return orderDelta;
      if (left.stepName === "supervisor" && right.stepName !== "supervisor") {
        return -1;
      }
      if (right.stepName === "supervisor" && left.stepName !== "supervisor") {
        return 1;
      }
      return left.stepName.localeCompare(right.stepName);
    })
    .map((node) => node.stepId);

  return { roots, nodes };
}

export function buildAgentTraceData(
  messages: ChatMessage[],
  activeSteps: ActiveStep[],
  traceEvents: TraceEvent[] = [],
): AgentTraceData | null {
  if (getTraceMode(messages, activeSteps, traceEvents) !== "agent") {
    return null;
  }
  if (hasCanonicalTrace(traceEvents)) {
    return buildCanonicalAgentTraceData(messages, traceEvents);
  }
  return buildStructuredAgentTraceData(messages, activeSteps, traceEvents);
}
