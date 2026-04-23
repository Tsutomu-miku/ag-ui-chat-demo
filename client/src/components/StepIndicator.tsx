import type { ActiveStep } from "ag-ui-react";

const STEP_META: Record<string, { icon: string; label: string; description: string }> = {
  supervisor: {
    icon: "🧠",
    label: "Supervisor",
    description: "Analysing request and coordinating agents...",
  },
  researcher: {
    icon: "🔍",
    label: "Researcher",
    description: "Gathering information using search tools...",
  },
  writer: {
    icon: "✍️",
    label: "Writer",
    description: "Composing and structuring content...",
  },
};

interface Props {
  steps: ActiveStep[];
}

export function StepIndicator({ steps }: Props) {
  if (steps.length === 0) return null;

  // Show the most recently started (deepest) step
  const current = steps[steps.length - 1];
  const meta = STEP_META[current.stepName] || {
    icon: "⚙️",
    label: current.stepName,
    description: "Working...",
  };

  // Build breadcrumb trail: supervisor > researcher
  const trail = steps.map(
    (s) => STEP_META[s.stepName]?.label || s.stepName,
  );

  return (
    <div className="step-indicator">
      <div className="step-indicator-inner">
        <span className="step-icon">{meta.icon}</span>
        <div className="step-info">
          <div className="step-trail">
            {trail.map((label, i) => (
              <span key={i}>
                {i > 0 && <span className="step-arrow"> › </span>}
                <span className={i === trail.length - 1 ? "step-current" : "step-parent"}>
                  {label}
                </span>
              </span>
            ))}
          </div>
          <div className="step-description">{meta.description}</div>
        </div>
        <span className="step-spinner" />
      </div>
    </div>
  );
}
