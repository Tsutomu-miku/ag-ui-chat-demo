import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ActiveStep, ChatMessage, ToolCallFunction } from "../types";

interface Props {
  messages: ChatMessage[];
  activeSteps: ActiveStep[];
}

interface AgentGroup {
  stepName: string;
  parentStepName?: string;
  messages: ChatMessage[];
}

const AGENT_LABELS: Record<string, { label: string; badge: string; role: string }> = {
  supervisor: { label: "Supervisor", badge: "SV", role: "Coordinator" },
  researcher: { label: "Researcher", badge: "RS", role: "Sub-agent" },
  writer: { label: "Writer", badge: "WR", role: "Sub-agent" },
};

const TOOL_LABELS: Record<string, { label: string; type: string }> = {
  get_weather: { label: "Weather Lookup", type: "backend" },
  search_web: { label: "Web Search", type: "backend" },
  calculate: { label: "Calculator", type: "backend" },
  get_current_time: { label: "Current Time", type: "backend" },
  confirm_action: { label: "Confirm Action", type: "frontend" },
  collect_user_input: { label: "User Input", type: "frontend" },
  delegate_to_subagent: { label: "Delegate", type: "delegation" },
};

function getAgentInfo(stepName: string) {
  return (
    AGENT_LABELS[stepName] || {
      label: stepName,
      badge: stepName.slice(0, 2).toUpperCase(),
      role: "Agent",
    }
  );
}

function getToolInfo(name: string) {
  return TOOL_LABELS[name] || { label: name, type: "backend" };
}

function formatJSON(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function parseToolArgs(toolCall: ToolCallFunction): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function getDelegatedAgent(toolCall: ToolCallFunction): string | undefined {
  if (toolCall.function.name !== "delegate_to_subagent") return undefined;

  const args = parseToolArgs(toolCall);
  return typeof args.agent === "string" ? args.agent : undefined;
}

function buildAgentGroups(messages: ChatMessage[], activeSteps: ActiveStep[]) {
  const groups = new Map<string, AgentGroup>();

  const ensureGroup = (stepName: string, parentStepName?: string) => {
    const existing = groups.get(stepName);
    if (existing) {
      existing.parentStepName ||= parentStepName;
      return existing;
    }

    const group = { stepName, parentStepName, messages: [] };
    groups.set(stepName, group);
    return group;
  };

  ensureGroup("supervisor");

  for (const step of activeSteps) {
    ensureGroup(step.stepName, step.parentStepName);
  }

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    const stepName = message.stepName || "supervisor";
    ensureGroup(stepName, message.parentStepName).messages.push(message);

    for (const toolCall of message.toolCalls || []) {
      const delegatedAgent = getDelegatedAgent(toolCall);
      if (delegatedAgent) {
        ensureGroup(delegatedAgent, stepName);
      }
    }
  }

  return groups;
}

function buildToolResultMap(messages: ChatMessage[]) {
  return new Map(
    messages
      .filter((message) => message.role === "tool" && message.toolCallId)
      .map((message) => [message.toolCallId as string, message.content]),
  );
}

function buildDelegatedAgentNames(messages: ChatMessage[]) {
  const names = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;

    for (const toolCall of message.toolCalls || []) {
      const delegatedAgent = getDelegatedAgent(toolCall);
      if (delegatedAgent) {
        names.add(delegatedAgent);
      }
    }
  }

  return names;
}

export function ExecutionTree({ messages, activeSteps }: Props) {
  const agentGroups = buildAgentGroups(messages, activeSteps);
  const toolResultById = buildToolResultMap(messages);
  const delegatedAgentNames = buildDelegatedAgentNames(messages);
  const activeStepNames = new Set(activeSteps.map((step) => step.stepName));
  const renderedAgents = new Set<string>();
  const hasTraceContent =
    messages.some((message) => message.role !== "tool") || activeSteps.length > 0;

  if (!hasTraceContent) return null;

  const supervisor = agentGroups.get("supervisor")!;
  const fallbackAgents = Array.from(agentGroups.values()).filter(
    (agent) =>
      agent.stepName !== "supervisor" &&
      !delegatedAgentNames.has(agent.stepName),
  );

  return (
    <section className="execution-tree" aria-label="Run trace">
      <div className="execution-tree-title">
        <span>Run trace</span>
        {activeSteps.length > 0 && <span className="trace-live">Live</span>}
      </div>
      <AgentNode
        agent={supervisor}
        agentGroups={agentGroups}
        toolResultById={toolResultById}
        activeStepNames={activeStepNames}
        renderedAgents={renderedAgents}
        depth={0}
      />
      {fallbackAgents
        .filter((agent) => !renderedAgents.has(agent.stepName))
        .map((agent) => (
          <AgentNode
            key={agent.stepName}
            agent={agent}
            agentGroups={agentGroups}
            toolResultById={toolResultById}
            activeStepNames={activeStepNames}
            renderedAgents={renderedAgents}
            depth={1}
          />
        ))}
    </section>
  );
}

interface AgentNodeProps {
  agent: AgentGroup;
  agentGroups: Map<string, AgentGroup>;
  toolResultById: Map<string, string>;
  activeStepNames: Set<string>;
  renderedAgents: Set<string>;
  depth: number;
}

function AgentNode({
  agent,
  agentGroups,
  toolResultById,
  activeStepNames,
  renderedAgents,
  depth,
}: AgentNodeProps) {
  const info = getAgentInfo(agent.stepName);
  const isActive = activeStepNames.has(agent.stepName);

  renderedAgents.add(agent.stepName);

  return (
    <div className={`agent-node depth-${depth} ${isActive ? "active" : ""}`}>
      <div className="agent-node-header">
        <span className="agent-badge">{info.badge}</span>
        <div className="agent-title">
          <span>{info.label}</span>
          <small>{info.role}</small>
        </div>
        <span className={`agent-status ${isActive ? "running" : "done"}`}>
          {isActive ? "Running" : "Done"}
        </span>
      </div>
      <div className="agent-node-body">
        {agent.messages.length === 0 && isActive && (
          <div className="trace-empty">
            <span className="trace-dot" />
            Receiving events
          </div>
        )}

        {agent.messages.map((message) => (
          <div className="trace-message" key={message.id}>
            {message.content && (
              <div className="trace-content">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {message.content}
                </ReactMarkdown>
                {message.isStreaming && <span className="cursor-blink">▊</span>}
              </div>
            )}

            {(message.toolCalls || []).map((toolCall) => (
              <TraceToolCall
                key={toolCall.id}
                toolCall={toolCall}
                result={toolResultById.get(toolCall.id)}
                toolResultById={toolResultById}
                agentGroups={agentGroups}
                activeStepNames={activeStepNames}
                renderedAgents={renderedAgents}
                depth={depth}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

interface TraceToolCallProps {
  toolCall: ToolCallFunction;
  result?: string;
  toolResultById: Map<string, string>;
  agentGroups: Map<string, AgentGroup>;
  activeStepNames: Set<string>;
  renderedAgents: Set<string>;
  depth: number;
}

function TraceToolCall({
  toolCall,
  result,
  toolResultById,
  agentGroups,
  activeStepNames,
  renderedAgents,
  depth,
}: TraceToolCallProps) {
  const info = getToolInfo(toolCall.function.name);
  const delegatedAgent = getDelegatedAgent(toolCall);
  const delegatedGroup = delegatedAgent ? agentGroups.get(delegatedAgent) : undefined;
  const showDelegatedGroup =
    delegatedGroup && !renderedAgents.has(delegatedGroup.stepName);

  return (
    <div className={`trace-tool ${info.type}`}>
      <div className="trace-tool-header">
        <span className="trace-tool-mark" />
        <span className="trace-tool-name">
          {delegatedAgent
            ? `${info.label} -> ${getAgentInfo(delegatedAgent).label}`
            : info.label}
        </span>
        <span className={`trace-tool-state ${toolCall.complete ? "done" : "running"}`}>
          {toolCall.complete ? "Complete" : "Running"}
        </span>
      </div>

      {toolCall.function.arguments && (
        <div className="trace-io">
          <span>Input</span>
          <pre>{formatJSON(toolCall.function.arguments)}</pre>
        </div>
      )}

      {result && toolCall.function.name !== "delegate_to_subagent" && (
        <div className="trace-io">
          <span>Output</span>
          <pre>{formatJSON(result)}</pre>
        </div>
      )}

      {showDelegatedGroup && (
        <div className="trace-child-agent">
          <AgentNode
            agent={delegatedGroup}
            agentGroups={agentGroups}
            toolResultById={toolResultById}
            activeStepNames={activeStepNames}
            renderedAgents={renderedAgents}
            depth={depth + 1}
          />
        </div>
      )}
    </div>
  );
}
