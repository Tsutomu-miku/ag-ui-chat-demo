import type {
  ActiveStep,
  AgUiTraceEvent,
  ChatMessage,
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
      return typeof event.value.agentId === "string" &&
        typeof event.value.agentName === "string" &&
        typeof event.value.kind === "string"
        ? (event.value as AgUiTraceEvent)
        : null;
    case "span.end":
      return typeof event.value.agentId === "string"
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
  if (typeof parsedArgs.input === "string" && parsedArgs.input.trim()) {
    return parsedArgs.input;
  }

  return args;
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
    traceEvents.some((event) =>
      hasStructuredAgentIdentity({
        stepId: event.stepId,
        parentStepId: event.parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
      }),
    ) ||
    messages.some((message) =>
      hasStructuredAgentIdentity({
        stepId: message.stepId,
        parentStepId: message.parentStepId,
        stepKind: message.stepKind,
        stepName: message.stepName,
        parentStepName: message.parentStepName,
      }),
    ) ||
    activeSteps.some((step) =>
      hasStructuredAgentIdentity({
        stepId: step.stepId,
        parentStepId: step.parentStepId,
        stepKind: step.stepKind,
        stepName: step.stepName,
        parentStepName: step.parentStepName,
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
  const stepName = normalizeStepName(message.stepName);
  if (
    !stepName ||
    stepName === "supervisor" ||
    !(
      message.stepKind === "subagent" ||
      message.parentStepId ||
      message.parentStepName
    )
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
    return existing;
  }

  const created: AgentTraceNode = {
    stepId,
    stepName,
    ...(stepKind ? { stepKind } : {}),
    ...(parentStepId ? { parentStepId } : {}),
    ...(parentStepName ? { parentStepName } : {}),
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
    const stepId = normalizeStepId(message.stepId, message.stepName);
    if (stepId) stepIds.add(stepId);
    if (message.parentStepId) stepIds.add(message.parentStepId);
    for (const toolCall of message.toolCalls ?? []) {
      const toolStepId = normalizeStepId(toolCall.stepId, toolCall.stepName);
      if (toolStepId) stepIds.add(toolStepId);
      if (toolCall.parentStepId) stepIds.add(toolCall.parentStepId);
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
  const agentIds = new Set<string>();
  const selected = new Set<number>();

  for (let index = 0; index < traceEvents.length; index++) {
    const event = traceEvents[index]!;
    const inBandAgentId = (event as TraceEvent & { agentId?: string }).agentId;

    if (
      (event.messageId && messageIds.has(event.messageId)) ||
      (event.parentMessageId && messageIds.has(event.parentMessageId)) ||
      (event.toolCallId && toolCallIds.has(event.toolCallId))
    ) {
      selected.add(index);
      if (event.stepId) stepIds.add(event.stepId);
      if (event.parentStepId) stepIds.add(event.parentStepId);
      if (inBandAgentId) agentIds.add(inBandAgentId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < traceEvents.length; index++) {
      if (selected.has(index)) continue;
      const event = traceEvents[index]!;
      const traceValue = getCanonicalTraceValue(event);
      const traceAgentId =
        traceValue?.type === "span.start" || traceValue?.type === "span.end"
          ? traceValue.agentId
          : undefined;
      const traceParentAgentId =
        traceValue?.type === "span.start" ? traceValue.parentAgentId : undefined;

      if (
        (traceAgentId && agentIds.has(traceAgentId)) ||
        (traceParentAgentId && agentIds.has(traceParentAgentId))
      ) {
        selected.add(index);
        if (traceAgentId) agentIds.add(traceAgentId);
        if (traceParentAgentId) agentIds.add(traceParentAgentId);
        changed = true;
        continue;
      }

      if (
        (event.stepId && stepIds.has(event.stepId)) ||
        (event.parentStepId && stepIds.has(event.parentStepId))
      ) {
        selected.add(index);
        if (event.stepId) stepIds.add(event.stepId);
        if (event.parentStepId) stepIds.add(event.parentStepId);
        const eventAgentId = (event as TraceEvent & { agentId?: string }).agentId;
        if (eventAgentId) agentIds.add(eventAgentId);
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
    const stepId = normalizeStepId(event.stepId, event.stepName);
    const parentStepId = normalizeStepId(
      event.parentStepId,
      event.parentStepName,
    );
    if (
      !stepId ||
      !isAgentStep({
        stepId,
        parentStepId,
        stepKind: event.stepKind,
        stepName: event.stepName,
        parentStepName: event.parentStepName,
      })
    ) {
      continue;
    }

    ensureTraceNode(
      nodes,
      stepId,
      event.stepName ?? stepId,
      event.stepKind,
      parentStepId,
      event.parentStepName,
      eventIndex,
    );

    if (parentStepId) {
      ensureTraceNode(
        nodes,
        parentStepId,
        event.parentStepName ?? parentStepId,
        event.parentStepId ? undefined : "supervisor",
        undefined,
        undefined,
        eventIndex,
      );
      linkParent(nodes, parentStepId, stepId);
    }
  }

  const activeStepOrderOffset = traceEvents.length;
  for (const [stepIndex, step] of activeSteps.entries()) {
    const stepId = normalizeStepId(step.stepId, step.stepName);
    const parentStepId = normalizeStepId(
      step.parentStepId,
      step.parentStepName,
    );
    if (
      !stepId ||
      !isAgentStep({
        stepId,
        parentStepId,
        stepKind: step.stepKind,
        stepName: step.stepName,
        parentStepName: step.parentStepName,
      })
    ) {
      continue;
    }

    ensureTraceNode(
      nodes,
      stepId,
      step.stepName,
      step.stepKind,
      parentStepId,
      step.parentStepName,
      activeStepOrderOffset + stepIndex,
    );
    if (parentStepId) {
      ensureTraceNode(
        nodes,
        parentStepId,
        step.parentStepName ?? parentStepId,
        "supervisor",
        undefined,
        undefined,
        activeStepOrderOffset + stepIndex,
      );
      linkParent(nodes, parentStepId, stepId);
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    const resolvedStepId = message.stepId;
    const resolvedParentStepId = message.parentStepId;
    if (
      resolvedStepId &&
      hasStructuredAgentIdentity({
        stepId: message.stepId,
        parentStepId: message.parentStepId,
        stepKind: message.stepKind,
        stepName: message.stepName,
        parentStepName: message.parentStepName,
      })
    ) {
      const node = ensureTraceNode(
        nodes,
        resolvedStepId,
        message.stepName ?? resolvedStepId,
        message.stepKind,
        resolvedParentStepId,
        message.parentStepName,
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
          message.parentStepName ?? resolvedParentStepId,
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
      agentId: string;
      traceOrder: number;
      toolCallName?: string;
      parentMessageId?: string;
    }
  >();

  const resolveAgentId = (agentId: string) =>
    spanAliases.get(agentId) ?? agentId;

  // First pass: process canonical span.start / span.end events to build the
  // agent tree (and handle supervisor-root/logical-span deduplication).
  for (const [eventIndex, event] of traceEvents.entries()) {
    const traceValue = getCanonicalTraceValue(event);
    if (!traceValue) continue;

    if (traceValue.type === "span.start") {
      const namespaceRoot = getCheckpointNamespaceRoot(traceValue);
      const resolvedParentAgentId = traceValue.parentAgentId
        ? resolveAgentId(traceValue.parentAgentId)
        : undefined;
      const logicalSpanKey =
        namespaceRoot &&
        !(traceValue.kind === "supervisor" && !resolvedParentAgentId)
          ? [
              traceValue.kind,
              traceValue.agentName,
              resolvedParentAgentId ?? "root",
              namespaceRoot,
            ].join("|")
          : undefined;
      const existingSupervisorRoot =
        traceValue.kind === "supervisor" && !resolvedParentAgentId
          ? Object.values(nodes).find(
              (node) =>
                node.stepKind === "supervisor" &&
                !node.parentStepId &&
                node.stepName === traceValue.agentName,
            )
          : undefined;
      const existingLogicalSpanId = logicalSpanKey
        ? logicalSpanIds.get(logicalSpanKey)
        : undefined;
      const agentId =
        existingSupervisorRoot?.stepId ??
        existingLogicalSpanId ??
        traceValue.agentId;
      if (existingSupervisorRoot) {
        spanAliases.set(traceValue.agentId, existingSupervisorRoot.stepId);
      }
      if (existingLogicalSpanId) {
        spanAliases.set(traceValue.agentId, existingLogicalSpanId);
      }
      if (logicalSpanKey && !existingLogicalSpanId) {
        logicalSpanIds.set(logicalSpanKey, agentId);
      }
      const parentAgentId = resolvedParentAgentId;
      const node = ensureTraceNode(
        nodes,
        agentId,
        traceValue.agentName,
        traceValue.kind,
        parentAgentId,
        undefined,
        eventIndex,
      );
      node.active = true;

      if (parentAgentId) {
        ensureTraceNode(
          nodes,
          parentAgentId,
          parentAgentId,
          undefined,
          undefined,
          undefined,
          eventIndex,
        );
        linkParent(nodes, parentAgentId, agentId);
      }
    }

    if (traceValue.type === "span.end") {
      const node = nodes[resolveAgentId(traceValue.agentId)];
      if (node) node.active = false;
    }
  }

  // Second pass: derive message→agent / tool→agent attribution from the
  // `agentId` stamped directly on message/tool events (in-band attribution).
  for (const [eventIndex, event] of traceEvents.entries()) {
    const inBandAgentId = (event as TraceEvent & { agentId?: string }).agentId;
    if (!inBandAgentId) continue;
    const agentId = resolveAgentId(inBandAgentId);

    if (event.type === "TEXT_MESSAGE_START" && event.messageId) {
      if (!messageSpanIds.has(event.messageId)) {
        messageSpanIds.set(event.messageId, agentId);
      }
    }

    if (event.type === "TOOL_CALL_START" && event.toolCallId) {
      if (!toolSpanIds.has(event.toolCallId)) {
        toolSpanIds.set(event.toolCallId, {
          agentId,
          traceOrder: eventIndex,
          ...(event.toolCallName ? { toolCallName: event.toolCallName } : {}),
          ...(event.parentMessageId
            ? { parentMessageId: event.parentMessageId }
            : {}),
        });
      }
      if (
        event.parentMessageId &&
        !messageSpanIds.has(event.parentMessageId)
      ) {
        messageSpanIds.set(event.parentMessageId, agentId);
      }
    }

    if (event.type === "TOOL_CALL_RESULT") {
      if (event.toolCallId && !toolSpanIds.has(event.toolCallId)) {
        toolSpanIds.set(event.toolCallId, {
          agentId,
          traceOrder: eventIndex,
          ...(event.toolCallName ? { toolCallName: event.toolCallName } : {}),
        });
      }
      if (event.messageId && !messageSpanIds.has(event.messageId)) {
        messageSpanIds.set(event.messageId, agentId);
      }
    }
  }

  for (const [messageIndex, message] of messages.entries()) {
    let agentId = messageSpanIds.get(message.id);
    if (!agentId && message.role === "assistant") {
      agentId = (message.toolCalls ?? [])
        .map((toolCall) => toolSpanIds.get(toolCall.id)?.agentId)
        .find((item): item is string => Boolean(item));
    }
    if (!agentId && message.role === "tool" && message.toolCallId) {
      agentId = toolSpanIds.get(message.toolCallId)?.agentId;
    }

    if (agentId && nodes[agentId]) {
      const node = nodes[agentId]!;
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
      const owner = toolSpanIds.get(toolCall.id);
      const ownerNode = owner ? nodes[owner.agentId] : undefined;
      if (
        ownerNode &&
        !ownerNode.toolCalls.some((item) => item.id === toolCall.id)
      ) {
        ownerNode.toolCalls.push(toolCall);
      }
      if (ownerNode) {
        ownerNode.toolOrders[toolCall.id] =
          nodes[agentId ?? ""]?.messageOrders[message.id] ?? messageIndex + 0.01;
      }
    }
  }

  for (const [toolCallId, owner] of toolSpanIds) {
    const node = nodes[owner.agentId];
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
