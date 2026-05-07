import { useEffect } from "react";
import type {
  ActiveStep,
  ChatMessage,
  ToolCallFunction,
  TraceEvent,
} from "ag-ui-react";

import { TraceMarkdown } from "./TraceMarkdown";
import {
  type AgentTraceNode,
  buildAgentTraceData,
  formatJSON,
  getAgentInfo,
  getDelegatedAgent,
  getDelegationInput,
  getToolInputDisplay,
  getToolResultDisplay,
  getToolInfo,
  isInternalDelegationTool,
  isSupervisorWrapUpText,
  isDelegationTool,
} from "./model";

interface Props {
  messages: ChatMessage[];
  activeSteps: ActiveStep[];
  traceEvents: TraceEvent[];
  toolResultById: Map<
    string,
    {
      content: string;
      isStreaming: boolean;
    }
  >;
}

export function AgentTraceView({
  messages,
  activeSteps,
  traceEvents,
  toolResultById,
}: Props) {
  const traceData = buildAgentTraceData(messages, activeSteps, traceEvents);

  useEffect(() => {
    console.log("[trace-debug] agent-trace-input", {
      messages: messages.map((message) => ({
        id: message.id,
        role: message.role,
        step: message.step,
        owner: message.owner,
        toolCalls: (message.toolCalls ?? []).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          step: toolCall.step,
          owner: toolCall.owner,
        })),
      })),
      activeSteps: activeSteps.map((step) => ({
        step: step.step,
        stepName: step.stepName,
        owner: step.owner,
      })),
      traceEvents: traceEvents.map((event) => {
        if (event.type === "CUSTOM") {
          return {
            type: event.type,
            name: event.name,
            value: event.value,
          };
        }

        return {
          type: event.type,
          messageId: event.messageId,
          parentMessageId: event.parentMessageId,
          toolCallId: event.toolCallId,
          step: event.step,
          owner: event.owner,
        };
      }),
      traceData: traceData
        ? {
            roots: traceData.roots,
            nodes: Object.fromEntries(
              Object.entries(traceData.nodes).map(([stepId, node]) => [
                stepId,
                {
                  stepName: node.stepName,
                  stepKind: node.stepKind,
                  parentStepId: node.parentStepId,
                  parentStepName: node.parentStepName,
                  childStepIds: node.childStepIds,
                  messageIds: node.messages.map((message) => message.id),
                  toolCallIds: node.toolCalls.map((toolCall) => toolCall.id),
                },
              ]),
            ),
          }
        : null,
    });
  }, [activeSteps, messages, traceData, traceEvents]);

  const activeStepIds = new Set(
    activeSteps
      .map((step) => step.step?.id || step.stepName)
      .filter((stepId): stepId is string => Boolean(stepId)),
  );
  const renderedAgents = new Set<string>();

  if (!traceData || traceData.roots.length === 0) {
    return (
      <div className="trace-empty">
        <span className="trace-dot" />
        Waiting for agent activity
      </div>
    );
  }

  return (
    <>
      {traceData.roots.map((stepId) => (
        <AgentNode
          key={stepId}
          stepId={stepId}
          traceData={traceData}
          toolResultById={toolResultById}
          activeStepIds={activeStepIds}
          renderedAgents={renderedAgents}
          depth={0}
        />
      ))}
    </>
  );
}

interface AgentNodeProps {
  stepId: string;
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>;
  toolResultById: Map<
    string,
    {
      content: string;
      isStreaming: boolean;
    }
  >;
  activeStepIds: Set<string>;
  renderedAgents: Set<string>;
  depth: number;
  input?: string;
}

interface AgentRenderItemMessage {
  type: "message";
  message: ChatMessage;
  order: number;
}

interface AgentRenderItemChild {
  type: "child";
  stepId: string;
  input?: string;
  anchorToolCallId?: string;
  order: number;
}

interface AgentRenderItemTool {
  type: "tool";
  toolCall: ToolCallFunction;
  order: number;
}

function getNodeBaseLabel(node: AgentTraceNode): string {
  return getAgentInfo(node.owner?.type ?? node.stepName).label;
}

function getNodePresentation(
  node: AgentTraceNode,
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
) {
  const nodeType = node.owner?.type ?? node.stepName;
  const info = getAgentInfo(nodeType);
  const siblings = Object.values(traceData.nodes)
    .filter(
      (candidate) =>
        (candidate.owner?.type ?? candidate.stepName) === nodeType &&
        candidate.parentStepId === node.parentStepId,
    )
    .sort((left, right) => {
      const orderDelta =
        getNodeRenderOrder(traceData, left.stepId) -
        getNodeRenderOrder(traceData, right.stepId);
      if (orderDelta !== 0) return orderDelta;
      return left.stepId.localeCompare(right.stepId);
    });
  const duplicateIndex = siblings.findIndex(
    (candidate) => candidate.stepId === node.stepId,
  );
  const baseLabel = getNodeBaseLabel(node);
  const label =
    nodeType !== "supervisor" && siblings.length > 1 && duplicateIndex >= 0
      ? `${baseLabel} #${duplicateIndex + 1}`
      : baseLabel;

  return { info, label };
}

type AgentRenderItem =
  | AgentRenderItemMessage
  | AgentRenderItemChild
  | AgentRenderItemTool;

function AgentNode({
  stepId,
  traceData,
  toolResultById,
  activeStepIds,
  renderedAgents,
  depth,
  input,
}: AgentNodeProps) {
  const agent = traceData.nodes[stepId];
  const { info, label } = getNodePresentation(agent, traceData);
  const parentAgent = agent.parentStepId
    ? traceData.nodes[agent.parentStepId]
    : undefined;
  const hierarchyPath = buildAgentHierarchyPath(stepId, traceData);
  const hierarchyText = hierarchyPath.map((item) => item.label).join(" -> ");
  const relationLabel = parentAgent
    ? `Sub-agent of ${getNodeBaseLabel(parentAgent)}`
    : "Root agent";
  const isActive = agent.active === true || activeStepIds.has(agent.stepId);
  const childStepIds = [...agent.childStepIds]
    .sort(
      (left, right) =>
        getNodeRenderOrder(traceData, left) -
        getNodeRenderOrder(traceData, right),
    )
    .filter((childStepId) => !renderedAgents.has(childStepId));
  const renderItems = buildAgentRenderItems(agent, childStepIds, traceData);
  const anchoredDelegationToolIds = new Set(
    renderItems
      .filter(
        (item): item is AgentRenderItemChild =>
          item.type === "child" && Boolean(item.anchorToolCallId),
      )
      .map((item) => item.anchorToolCallId as string),
  );
  const hasRenderableContent =
    Boolean(input) ||
    agent.messages.some(
      (message) =>
        (message.role === "assistant" && message.content.trim().length > 0) ||
        (message.toolCalls?.length ?? 0) > 0,
    ) ||
    agent.toolCalls.length > 0 ||
    childStepIds.length > 0;
  const lastRenderableAssistantMessageId = [...agent.messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && message.content.trim().length > 0,
    )?.id;
  const firstRenderableAssistantMessageId = agent.messages.find(
    (message) =>
      message.role === "assistant" && message.content.trim().length > 0,
  )?.id;

  renderedAgents.add(agent.stepId);

  return (
    <div
      className={`agent-node depth-${depth} ${isActive ? "active" : ""} ${parentAgent ? "is-child" : "is-root"}`}
    >
      <div className="agent-node-meta">
        <span className={`agent-relation ${parentAgent ? "child" : "root"}`}>
          {relationLabel}
        </span>
        <span className="agent-hierarchy-path">{hierarchyText}</span>
      </div>
      <div className="agent-node-header">
        <span className="agent-badge">{info.badge}</span>
        <div className="agent-title">
          <span>{label}</span>
          <div className="agent-title-meta">
            <small>{info.role}</small>
            {parentAgent && (
              <small className="agent-parent-name">
                Parent: {getNodeBaseLabel(parentAgent)}
              </small>
            )}
          </div>
        </div>
        <span className={`agent-status ${isActive ? "running" : "done"}`}>
          {isActive ? "Running" : "Done"}
        </span>
      </div>

      <div className="agent-node-body">
        {input && <TraceSubagentInput input={input} />}

        {!hasRenderableContent && isActive && (
          <div className="trace-empty">
            <span className="trace-dot" />
            Receiving events
          </div>
        )}

        {renderItems.map((item) => {
          if (item.type === "message") {
            return (
              <TraceMessageBlock
                key={item.message.id}
                message={item.message}
                traceData={traceData}
                toolResultById={toolResultById}
                hiddenToolCallIds={anchoredDelegationToolIds}
                firstRenderableAssistantMessageId={
                  firstRenderableAssistantMessageId
                }
                lastRenderableAssistantMessageId={
                  lastRenderableAssistantMessageId
                }
              />
            );
          }

          if (item.type === "tool") {
            return (
              <TraceToolCall
                key={item.toolCall.id}
                toolCall={item.toolCall}
                result={toolResultById.get(item.toolCall.id)}
                showInput={!isDelegationTool(item.toolCall.function.name)}
              />
            );
          }

          return (
            <AgentNode
              key={item.stepId}
              stepId={item.stepId}
              traceData={traceData}
              toolResultById={toolResultById}
              activeStepIds={activeStepIds}
              renderedAgents={renderedAgents}
              depth={depth + 1}
              input={item.input}
            />
          );
        })}
      </div>
    </div>
  );
}

function findChildAnchor(
  agent: AgentTraceNode,
  childStepId: string,
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
  usedToolCallIds: Set<string>,
): { order: number; toolCall: ToolCallFunction } | undefined {
  const child = traceData.nodes[childStepId];
  if (!child) return undefined;

  const anchors: { order: number; toolCall: ToolCallFunction }[] = [];
  const seenToolCallIds = new Set<string>();
  const addAnchor = (
    toolCall: ToolCallFunction,
    fallbackOrder: number | undefined,
  ) => {
    if (seenToolCallIds.has(toolCall.id)) return;
    if (usedToolCallIds.has(toolCall.id)) return;
    if (getDelegatedAgent(toolCall) !== child.stepName) return;

    seenToolCallIds.add(toolCall.id);
    anchors.push({
      toolCall,
      order:
        agent.toolOrders[toolCall.id] ??
        fallbackOrder ??
        child.order ??
        Number.MAX_SAFE_INTEGER,
    });
  };

  for (const message of agent.messages) {
    const messageOrder = agent.messageOrders[message.id];
    for (const toolCall of message.toolCalls ?? []) {
      addAnchor(toolCall, messageOrder);
    }
  }

  for (const toolCall of agent.toolCalls) {
    addAnchor(toolCall, agent.toolOrders[toolCall.id]);
  }

  if (anchors.length === 0) return undefined;

  const childOrder = getFirstNodeMessageOrder(child) ?? Number.MAX_SAFE_INTEGER;
  const anchor =
    anchors
      .filter((item) => item.order <= childOrder)
      .sort((left, right) => right.order - left.order)[0] ??
    anchors.sort((left, right) => left.order - right.order)[0];

  if (anchor) {
    usedToolCallIds.add(anchor.toolCall.id);
  }

  return anchor;
}

function getFirstNodeMessageOrder(node: AgentTraceNode): number | undefined {
  const orders = [
    ...node.messages
      .map((message) => node.messageOrders[message.id])
      .filter((order): order is number => order !== undefined),
    ...node.toolCalls
      .map((toolCall) => node.toolOrders[toolCall.id])
      .filter((order): order is number => order !== undefined),
  ];

  return orders.length > 0 ? Math.min(...orders) : undefined;
}

function buildAgentHierarchyPath(
  stepId: string,
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
): Array<{ stepId: string; label: string }> {
  const path: Array<{ stepId: string; label: string }> = [];
  const visited = new Set<string>();
  let currentStepId: string | undefined = stepId;

  while (currentStepId && !visited.has(currentStepId)) {
    visited.add(currentStepId);
    const node: AgentTraceNode | undefined = traceData.nodes[currentStepId];
    if (!node) break;
    path.unshift({
      stepId: node.stepId,
      label: getNodeBaseLabel(node),
    });
    currentStepId = node.parentStepId;
  }

  return path;
}

function getNodeRenderOrder(
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
  stepId: string,
): number {
  const node = traceData.nodes[stepId];
  if (!node) return Number.MAX_SAFE_INTEGER;
  return (
    getFirstNodeMessageOrder(node) ?? node.order ?? Number.MAX_SAFE_INTEGER
  );
}

function isAnchoredDelegationTool(
  _agent: AgentTraceNode,
  toolCall: ToolCallFunction,
  childStepIds: string[],
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
): boolean {
  if (!isDelegationTool(toolCall.function.name)) return false;
  return childStepIds.some((childStepId) => {
    const child = traceData.nodes[childStepId];
    return child ? getDelegatedAgent(toolCall) === child.stepName : false;
  });
}

export function buildAgentRenderItems(
  agent: AgentTraceNode,
  childStepIds: string[],
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
): AgentRenderItem[] {
  const items: AgentRenderItem[] = [];
  const usedDelegationToolIds = new Set<string>();
  const messageById = new Map(
    agent.messages.map((message) => [message.id, message]),
  );
  const toolCallById = new Map(
    agent.toolCalls.map((toolCall) => [toolCall.id, toolCall]),
  );
  const renderedToolIds = new Set(
    agent.messages.flatMap((message) =>
      (message.toolCalls ?? []).map((toolCall) => toolCall.id),
    ),
  );
  const renderedChildStepIds = new Set<string>();
  const renderedStandaloneToolIds = new Set<string>();

  const pushChild = (childStepId: string) => {
    if (!childStepIds.includes(childStepId)) return;
    if (renderedChildStepIds.has(childStepId)) return;
    const anchor = findChildAnchor(
      agent,
      childStepId,
      traceData,
      usedDelegationToolIds,
    );
    items.push({
      type: "child",
      stepId: childStepId,
      ...(anchor ? { anchorToolCallId: anchor.toolCall.id } : {}),
      input: anchor ? getDelegationInput(anchor.toolCall) : undefined,
      order: items.length,
    });
    renderedChildStepIds.add(childStepId);
  };

  for (const renderItem of agent.renderItems) {
    if (renderItem.type === "message") {
      const message = messageById.get(renderItem.messageId);
      if (message && message.role !== "tool") {
        items.push({ type: "message", message, order: items.length });
      }
      continue;
    }

    if (renderItem.type === "tool") {
      if (renderedToolIds.has(renderItem.toolCallId)) continue;
      const toolCall = toolCallById.get(renderItem.toolCallId);
      if (toolCall) {
        if (isInternalDelegationTool(toolCall.function.name)) continue;
        if (isAnchoredDelegationTool(agent, toolCall, childStepIds, traceData)) {
          continue;
        }
        items.push({ type: "tool", toolCall, order: items.length });
        renderedStandaloneToolIds.add(toolCall.id);
      }
      continue;
    }

    pushChild(renderItem.stepId);
  }

  for (const childStepId of childStepIds) {
    pushChild(childStepId);
  }

  for (const toolCall of agent.toolCalls) {
    if (renderedToolIds.has(toolCall.id)) continue;
    if (renderedStandaloneToolIds.has(toolCall.id)) continue;
    if (isInternalDelegationTool(toolCall.function.name)) continue;
    if (isAnchoredDelegationTool(agent, toolCall, childStepIds, traceData)) {
      continue;
    }
    items.push({ type: "tool", toolCall, order: items.length });
  }

  return items;
}

function TraceSubagentInput({ input }: { input: string }) {
  return (
    <div className="trace-subagent-input">
      <div className="trace-io">
        <span>Input</span>
        <pre>{formatJSON(input)}</pre>
      </div>
    </div>
  );
}

interface TraceMessageBlockProps {
  message: ChatMessage;
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>;
  toolResultById: Map<
    string,
    {
      content: string;
      isStreaming: boolean;
    }
  >;
  hiddenToolCallIds: Set<string>;
  firstRenderableAssistantMessageId?: string;
  lastRenderableAssistantMessageId?: string;
}

function TraceMessageBlock({
  message,
  traceData,
  toolResultById,
  hiddenToolCallIds,
  firstRenderableAssistantMessageId,
  lastRenderableAssistantMessageId,
}: TraceMessageBlockProps) {
  const shouldRenderMessageContent =
    message.role === "assistant" && message.content.trim().length > 0;
  const messageBadge = getTraceMessageBadge(
    message,
    traceData,
    message.id === firstRenderableAssistantMessageId,
    message.id === lastRenderableAssistantMessageId,
  );

  return (
    <div className="trace-message">
      {shouldRenderMessageContent && (
        <>
          {messageBadge && (
            <div className="trace-message-badge">{messageBadge}</div>
          )}
          <TraceMarkdown
            content={message.content}
            isStreaming={message.isStreaming}
            className="trace-content"
          />
        </>
      )}

      {(message.toolCalls ?? [])
        .filter(
          (toolCall) =>
            !hiddenToolCallIds.has(toolCall.id) &&
            !isInternalDelegationTool(toolCall.function.name),
        )
        .map((toolCall) => (
          <TraceToolCall
            key={toolCall.id}
            toolCall={toolCall}
            result={toolResultById.get(toolCall.id)}
            showInput={!isDelegationTool(toolCall.function.name)}
          />
        ))}
    </div>
  );
}

interface TraceToolCallProps {
  toolCall: ToolCallFunction;
  result?: {
    content: string;
    isStreaming: boolean;
  };
  showInput?: boolean;
}

function TraceToolCall({
  toolCall,
  result,
  showInput = true,
}: TraceToolCallProps) {
  const info = getToolInfo(toolCall.function.name);
  const delegatedAgent = getDelegatedAgent(toolCall);
  const inputDisplay = getToolInputDisplay(toolCall);
  const resultDisplay = result ? getToolResultDisplay(result) : undefined;

  return (
    <div className={`trace-tool ${info.type}`}>
      <div className="trace-tool-header">
        <span className="trace-tool-mark" />
        <span className="trace-tool-name">
          {delegatedAgent
            ? `${info.label} -> ${getAgentInfo(delegatedAgent).label}`
            : info.label}
        </span>
        <span
          className={`trace-tool-state ${toolCall.complete ? "done" : "running"}`}
        >
          {toolCall.complete ? "Complete" : "Running"}
        </span>
      </div>

      {showInput && inputDisplay && (
        <div className="trace-io">
          <span>{inputDisplay.isStreaming ? "Input streaming" : "Input"}</span>
          <pre>
            {inputDisplay.content}
            {inputDisplay.isStreaming && (
              <span className="cursor-blink">▊</span>
            )}
          </pre>
        </div>
      )}

      {resultDisplay && !isDelegationTool(toolCall.function.name) && (
        <div className="trace-io">
          <span>
            {resultDisplay.isStreaming ? "Output streaming" : "Output"}
          </span>
          <pre>
            {resultDisplay.content}
            {resultDisplay.isStreaming && (
              <span className="cursor-blink">▊</span>
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

export function getTraceMessageBadge(
  message: ChatMessage,
  traceData: NonNullable<ReturnType<typeof buildAgentTraceData>>,
  isFirstRenderableAssistantMessage: boolean,
  isLastRenderableAssistantMessage: boolean,
): string | undefined {
  const ownerNode = Object.values(traceData.nodes).find((node) =>
    node.messages.some((item) => item.id === message.id),
  );
  const messageStep = message.step;
  const stepName = messageStep?.name ?? ownerNode?.stepName;
  const content = message.content.trim();
  const isExplicitSubagentMessage = Boolean(
    messageStep?.kind === "subagent" ||
    messageStep?.parentId ||
    ownerNode?.stepKind === "subagent" ||
    ownerNode?.parentStepId,
  );

  if (!content) return undefined;
  if (stepName === "supervisor" && isSupervisorWrapUpText(content)) {
    return "Supervisor summary";
  }
  if (isExplicitSubagentMessage && isLastRenderableAssistantMessage) {
    return "Sub-agent output";
  }
  if (isExplicitSubagentMessage && isFirstRenderableAssistantMessage) {
    return "Sub-agent progress";
  }

  return undefined;
}
