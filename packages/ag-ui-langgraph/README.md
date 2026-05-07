# ag-ui-langgraph

TypeScript AG-UI adapter for LangGraph compiled graphs. The package mirrors the
official Python `ag_ui_langgraph` integration pattern:

```text
LangGraph compiled graph -> graph.streamEvents({ version: "v2" }) -> AG-UI events
```

## Quick Start

```ts
import { LangGraphAgent } from "ag-ui-langgraph";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const graph = createReactAgent({ llm: model, tools });
const agent = new LangGraphAgent({ name: "assistant", graph });

for await (const event of agent.clone().run(input)) {
  // Forward each AG-UI event to your runtime, transport, or client.
  console.log(event);
}
```

`clone()` should be used per request so stream-local state such as in-progress
messages, tool calls, reasoning blocks, and active steps is isolated.
`ag-ui-langgraph` does not require a specific HTTP framework; expose the
returned async generator through whatever transport your application uses.

## Public API

```ts
class LangGraphAgent {
  constructor(config: LangGraphAgentConfig);
  clone(): LangGraphAgent;
  run(input: RunAgentInput): AsyncGenerator<BaseEvent>;
}

interface LangGraphAgentConfig {
  name: string;
  graph: LocalCompiledGraph;
  description?: string;
  config?: Record<string, unknown>;
}
```

Convenience factories are also exported:

- `createReactAgent(config)` builds a LangGraph prebuilt React agent and wraps it.
- `createSupervisor(config)` builds a real
  `@langchain/langgraph-supervisor` topology from named sub-agents, compiles it,
  and wraps it.

The npm package intentionally exposes only the root entrypoint:

```ts
import { LangGraphAgent, createReactAgent } from "ag-ui-langgraph";
```

Internal source directories are organized for maintainers, not as npm subpath
exports. Treat imports such as `ag-ui-langgraph/messages` or
`ag-ui-langgraph/runtime` as unsupported.

## Source Layout

The TypeScript implementation is organized by runtime responsibility rather
than by mirroring the Python file names:

```text
src/
  agent/        stream-local agent state, reasoning helpers, trace state
  messages/     AG-UI <-> LangChain message conversion and JSON-safe utilities
  runtime/      LangGraph graph/input/stream interop helpers
  state/        schema-key filtering and state merge helpers
  translation/  LangGraph event translation context and event helpers
  shared/       small cross-domain guards
```

`src/agent.ts` remains the primary adapter class and orchestrates these focused
modules. Compatibility shims are kept only where they avoid unnecessary churn;
new implementation code should prefer the domain directories above.

## Event Translation

| LangGraph event | AG-UI event(s) |
|---|---|
| `on_chat_model_stream` text | `TEXT_MESSAGE_START`, `TEXT_MESSAGE_CONTENT` |
| `on_chat_model_stream` tool chunks | `TOOL_CALL_START`, `TOOL_CALL_ARGS` |
| `on_chat_model_end` | `TEXT_MESSAGE_END` or `TOOL_CALL_END` |
| `on_tool_end` | `TOOL_CALL_RESULT` and fallback tool-call lifecycle |
| `on_custom_event` manual emitters | text/tool/state events plus `CUSTOM` |
| `on_chain_end` state output | `STATE_SNAPSHOT` when state changes |
| node metadata changes | `STEP_STARTED`, `STEP_FINISHED` |
| reasoning content blocks | `REASONING_*` events |
| every LangGraph event | `RAW` event with JSON-safe payload |

## Agent Attribution

Sub-agent ownership is emitted in-band on standard AG-UI events via passthrough
fields:

```ts
{
  type: "TOOL_CALL_START",
  toolCallId: "call-1",
  toolCallName: "compose_text",
  parentMessageId: "message-1",
  agentId: "run-1:writer:branch-a",
  agentName: "writer"
}
```

`agentId` is an opaque concrete sub-agent instance id, not a display name or a
span id. Two concurrent `writer` sub-agents share `agentName: "writer"` but must
have different `agentId` values. The adapter derives this id from LangGraph
checkpoint namespaces when available, then reuses the recorded `messageId` /
`toolCallId` ownership for follow-up chunks and results. No `ag-ui.trace`
`span.start` / `span.end` custom events are emitted.

## Python Alignment Notes

Implemented alignment points include checkpoint-aware stream preparation,
interrupt short-circuiting, `Command` resume, regeneration/time-travel fallback,
schema-key filtering, state/message snapshots, subgraph stream options,
frontend tool pause/resume semantics, `ag-ui`/`copilotkit` state exposure,
A2UI schema context separation, orphan tool-message repair, predict-state
snapshot suppression, and provider-specific reasoning extraction.

## Testing

```bash
pnpm --filter ag-ui-langgraph run test
pnpm --filter ag-ui-langgraph run test:coverage
pnpm --filter ag-ui-langgraph run typecheck
```

The package test suite covers conversion utilities, reasoning extraction,
JSON-safe serialization, schema filtering, checkpoint/interrupt behavior, state
merge behavior, factory helpers, runtime graph helpers, and LangGraph event
translation. `test:coverage` enforces global coverage thresholds before
publishing.

Tests follow the same domain boundaries as `src`:

```text
tests/
  agent/
  messages/
  runtime/
  state/
  shared/
  translation/
  package/
```

## Publishing

The npm package is emitted from `dist`:

```bash
pnpm --filter ag-ui-langgraph run typecheck
pnpm --filter ag-ui-langgraph run test:coverage
pnpm --filter ag-ui-langgraph run build
pnpm --filter ag-ui-langgraph run publish:check-name
pnpm --filter ag-ui-langgraph run publish:dry
```

The build script removes `dist` before compiling so deleted modules cannot leak
into the tarball. `publish:dry` runs `npm pack --dry-run`; the real publish step
is intentionally left to the package owner.
