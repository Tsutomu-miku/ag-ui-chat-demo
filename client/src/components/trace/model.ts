import type {
  ActiveStep,
  AgentEventRecord as AgUiAgentEventRecord,
  ChatMessage,
  ExecutionStep,
  ToolCallFunction,
} from "ag-ui-react";

export type AgentEventRecord = AgUiAgentEventRecord;

export interface VisualizationOwner {
  key: string;
  type: string;
  instanceId: string;
  parentKey?: string;
}

interface VisualizationPayload {
  step?: ExecutionStep;
  owner?: VisualizationOwner;
}

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
  owner?: VisualizationOwner;
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

function isInternalStepLabel(value?: string): boolean {
  const normalized = value?.trim();
  return (
    normalized === "__start__" ||
    normalized === "__end__" ||
    normalized === "__"
  );
}

function getVisualizationPayload(value: {
  extra?: Record<string, unknown>;
}): VisualizationPayload | undefined {
  const visualization = isRecord(value.extra?.visualization)
    ? value.extra.visualization
    : null;
  if (!visualization) return undefined;

  const step = isRecord(visualization.step) ? visualization.step : null;
  const owner = isRecord(visualization.owner) ? visualization.owner : null;
  const normalizedOwner =
    typeof owner?.key === "string" &&
    typeof owner.type === "string" &&
    typeof owner.instanceId === "string"
      ? {
          key: owner.key,
          type: owner.type,
          instanceId: owner.instanceId,
          ...(typeof owner.parentKey === "string"
            ? { parentKey: owner.parentKey }
            : {}),
        }
      : undefined;
  const normalizedStep =
    typeof step?.name === "string" && !isInternalStepLabel(step.name)
      ? {
          ...(typeof step.id === "string" ? { id: step.id } : {}),
          ...(typeof step.parentId === "string"
            ? { parentId: step.parentId }
            : {}),
          ...(typeof step.kind === "string" ? { kind: step.kind } : {}),
          name: step.name,
        }
      : undefined;

  if (!normalizedOwner && !normalizedStep) return undefined;
  return {
    ...(normalizedStep ? { step: normalizedStep } : {}),
    ...(normalizedOwner ? { owner: normalizedOwner } : {}),
  };
}

function getVisualizationStep(value: {
  step?: ExecutionStep;
  extra?: Record<string, unknown>;
}): ExecutionStep | undefined {
  return getVisualizationPayload(value)?.step ?? value.step;
}

function getVisualizationOwner(value: {
  extra?: Record<string, unknown>;
}): VisualizationOwner | undefined {
  return getVisualizationPayload(value)?.owner;
}

function normalizeStepName(stepName?: string): string | undefined {
  return stepName && stepName.trim() && !isInternalStepLabel(stepName)
    ? stepName
    : undefined;
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

function resolveNodeStepName(opts: {
  stepName?: string;
  ownerType?: string;
  stepId: string;
}): string {
  return normalizeStepName(opts.stepName) ?? opts.ownerType ?? opts.stepId;
}

function isAgentStep(opts: {
  stepId?: string;
  parentStepId?: string;
  stepKind?: string;
  stepName?: string;
  parentStepName?: string;
}): boolean {
  return Boolean(
    opts.stepKind === "agent" ||
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
    opts.stepKind === "agent" ||
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
  events: AgentEventRecord[] = [],
): TraceMode {
  const toolCalls = collectToolCalls(messages);
  const hasToolActivity =
    toolCalls.length > 0 || messages.some((message) => message.role === "tool");
  const hasStructuredAgentTrace =
    events.some((event) => {
      const step = getVisualizationStep(event);
      return hasStructuredAgentIdentity({
        stepId: step?.id,
        parentStepId: step?.parentId,
        stepKind: step?.kind,
        stepName: step?.name,
      });
    }) ||
    messages.some((message) => {
      const step = getVisualizationStep(message);
      return hasStructuredAgentIdentity({
        stepId: step?.id,
        parentStepId: step?.parentId,
        stepKind: step?.kind,
        stepName: step?.name,
      });
    }) ||
    messages.some((message) =>
      (message.toolCalls ?? []).some((toolCall) => {
        const step = getVisualizationStep(toolCall);
        return hasStructuredAgentIdentity({
          stepId: step?.id,
          parentStepId: step?.parentId,
          stepKind: step?.kind,
          stepName: step?.name,
        });
      }),
    ) ||
    activeSteps.some((activeStep) =>
      hasStructuredAgentIdentity({
        stepId: getVisualizationStep(activeStep)?.id,
        parentStepId: getVisualizationStep(activeStep)?.parentId,
        stepKind: getVisualizationStep(activeStep)?.kind,
        stepName: getVisualizationStep(activeStep)?.name ?? activeStep.stepName,
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
  events: AgentEventRecord[] = [],
): TurnPresentation {
  const traceMode = getTraceMode(messages, activeSteps, events);
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
  const step = getVisualizationStep(message);
  const stepName = normalizeStepName(step?.name);
  if (
    !stepName ||
    stepName === "supervisor" ||
    !(step?.kind === "subagent" || step?.parentId)
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
  owner?: VisualizationOwner,
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

function linkKnownParents(nodes: Record<string, AgentTraceNode>) {
  for (const node of Object.values(nodes)) {
    const parentStepId = node.parentStepId;
    if (!parentStepId) continue;
    const parent = nodes[parentStepId];
    if (!parent) continue;

    node.parentStepName ||= parent.stepName;
    linkParent(nodes, parentStepId, node.stepId);
  }
}

function collectStepIdsFromMessages(messages: ChatMessage[]) {
  const stepIds = new Set<string>();

  for (const message of messages) {
    const messageStep = getVisualizationStep(message);
    const stepId = normalizeStepId(messageStep?.id, messageStep?.name);
    if (stepId) stepIds.add(stepId);
    if (messageStep?.parentId) stepIds.add(messageStep.parentId);
    for (const toolCall of message.toolCalls ?? []) {
      const toolStep = getVisualizationStep(toolCall);
      const toolStepId = normalizeStepId(toolStep?.id, toolStep?.name);
      if (toolStepId) stepIds.add(toolStepId);
      if (toolStep?.parentId) stepIds.add(toolStep.parentId);
    }
  }

  return stepIds;
}

export function filterEventsForTurn(
  events: AgentEventRecord[],
  messages: ChatMessage[],
  includeUnlinkedEvents = false,
): AgentEventRecord[] {
  if (events.length === 0) return [];

  if (includeUnlinkedEvents && messages.length === 0) {
    const lastRunStartIndex = events.reduce(
      (latest, event, index) => (event.type === "RUN_STARTED" ? index : latest),
      -1,
    );
    return events
      .slice(lastRunStartIndex + 1)
      .filter(
        (event) =>
          event.type !== "RUN_STARTED" &&
          event.type !== "RUN_FINISHED" &&
          Boolean(getVisualizationPayload(event)),
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

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const step = getVisualizationStep(event);

    if (
      (event.messageId && messageIds.has(event.messageId)) ||
      (event.parentMessageId && messageIds.has(event.parentMessageId)) ||
      (event.toolCallId && toolCallIds.has(event.toolCallId))
    ) {
      selected.add(index);
      if (step?.id) stepIds.add(step.id);
      if (step?.parentId) stepIds.add(step.parentId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < events.length; index++) {
      if (selected.has(index)) continue;
      const event = events[index]!;
      const step = getVisualizationStep(event);

      if (
        (step?.id && stepIds.has(step.id)) ||
        (step?.parentId && stepIds.has(step.parentId))
      ) {
        selected.add(index);
        if (step?.id) stepIds.add(step.id);
        if (step?.parentId) stepIds.add(step.parentId);
        changed = true;
      }
    }
  }

  return [...selected]
    .sort((left, right) => left - right)
    .map((index) => events[index]!)
    .filter(
      (event) => event.type !== "RUN_STARTED" && event.type !== "RUN_FINISHED",
    );
}

function buildStructuredAgentTraceData(
  messages: ChatMessage[],
  activeSteps: ActiveStep[],
  events: AgentEventRecord[],
): AgentTraceData | null {
  const nodes: Record<string, AgentTraceNode> = {};

  for (const [eventIndex, event] of events.entries()) {
    const step = getVisualizationStep(event);
    const owner = getVisualizationOwner(event);
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
      resolveNodeStepName({
        stepName: step?.name,
        ownerType: owner?.type,
        stepId,
      }),
      step?.kind,
      parentStepId,
      parentStepId ? nodes[parentStepId]?.stepName : undefined,
      eventIndex,
      owner,
    );
  }

  const activeStepOrderOffset = events.length;
  for (const [stepIndex, step] of activeSteps.entries()) {
    const stepRef = getVisualizationStep(step);
    const owner = getVisualizationOwner(step);
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
      resolveNodeStepName({
        stepName: stepRef?.name ?? step.stepName,
        ownerType: owner?.type,
        stepId,
      }),
      stepRef?.kind,
      parentStepId,
      parentStepId ? nodes[parentStepId]?.stepName : undefined,
      activeStepOrderOffset + stepIndex,
      owner,
    );
  }

  for (const [messageIndex, message] of messages.entries()) {
    const messageStep = getVisualizationStep(message);
    const messageOwner = getVisualizationOwner(message);
    const resolvedStepId = messageStep?.id;
    const resolvedParentStepId = messageStep?.parentId;
    if (
      resolvedStepId &&
      hasStructuredAgentIdentity({
        stepId: messageStep?.id,
        parentStepId: messageStep?.parentId,
        stepKind: messageStep?.kind,
        stepName: messageStep?.name,
      })
    ) {
      const node = ensureTraceNode(
        nodes,
        resolvedStepId,
        resolveNodeStepName({
          stepName: messageStep?.name,
          ownerType: messageOwner?.type,
          stepId: resolvedStepId,
        }),
        messageStep?.kind,
        resolvedParentStepId,
        resolvedParentStepId
          ? nodes[resolvedParentStepId]?.stepName
          : undefined,
        messageIndex,
        messageOwner,
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
        pushChildRenderItem(nodes, resolvedParentStepId, resolvedStepId);
      }
    }

    for (const toolCall of message.toolCalls ?? []) {
      const toolStep = getVisualizationStep(toolCall);
      const toolOwner = getVisualizationOwner(toolCall);
      const toolStepId = normalizeStepId(toolStep?.id, toolStep?.name);
      const parentStepId = normalizeStepId(toolStep?.parentId);
      if (!toolStepId) continue;
      const node = ensureTraceNode(
        nodes,
        toolStepId,
        resolveNodeStepName({
          stepName: toolStep?.name,
          ownerType: toolOwner?.type,
          stepId: toolStepId,
        }),
        toolStep?.kind,
        parentStepId,
        parentStepId ? nodes[parentStepId]?.stepName : undefined,
        messageIndex,
        toolOwner,
      );
      if (!node.toolCalls.some((item) => item.id === toolCall.id)) {
        node.toolCalls.push(toolCall);
      }
      node.toolOrders[toolCall.id] = messageIndex + 0.01;
      if (parentStepId) {
        pushChildRenderItem(nodes, parentStepId, toolStepId);
      }
    }
  }

  if (Object.keys(nodes).length === 0) {
    return null;
  }

  linkKnownParents(nodes);

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
  events: AgentEventRecord[] = [],
): AgentTraceData | null {
  if (getTraceMode(messages, activeSteps, events) !== "agent") {
    return null;
  }
  return buildStructuredAgentTraceData(messages, activeSteps, events);
}
