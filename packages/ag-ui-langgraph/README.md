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
import { createAgentEndpoint } from "ag-ui-hono";

const graph = createReactAgent({ llm: model, tools });
const agent = new LangGraphAgent({ name: "assistant", graph });

const app = createAgentEndpoint((input) => agent.clone().run(input));
```

`clone()` should be used per request so stream-local state such as in-progress
messages, tool calls, reasoning blocks, and active steps is isolated.

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
  eventExtensions?: LangGraphEventExtension[];
}
```

Convenience factories are also exported:

- `createReactAgent(config)` builds a LangGraph prebuilt React agent and wraps it.
- `createSupervisor(config)` builds a real
  `@langchain/langgraph-supervisor` topology from named sub-agents, compiles it,
  and wraps it.

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

## Event Extensions

`ag-ui-langgraph` does not assign business ownership, agent identity, or
visualization semantics. Use event extensions to add application-defined
metadata to standard AG-UI events before they are yielded or encoded:

```ts
import { mergeEventExtra, type LangGraphEventExtension } from "ag-ui-langgraph";

const visualization: LangGraphEventExtension = {
  name: "my-app.visualization",
  beforeDispatchEvent(event, context) {
    mergeEventExtra(event, {
      visualization: {
        node: context.langgraph.nodeName,
      },
    });
  },
};

const agent = new LangGraphAgent({
  name: "assistant",
  graph,
  eventExtensions: [visualization],
});
```

`mergeEventExtra(event, extra)` performs only a shallow merge into
`event.extra`; the package does not interpret keys inside `extra`.

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
pnpm --filter ag-ui-langgraph run typecheck
```

The package test suite covers conversion utilities, reasoning extraction,
JSON-safe serialization, schema filtering, checkpoint/interrupt behavior, state
merge behavior, and LangGraph event translation.

## Publishing

The npm package is emitted from `dist`:

```bash
pnpm --filter ag-ui-langgraph run typecheck
pnpm --filter ag-ui-langgraph run test
pnpm --filter ag-ui-langgraph run build
pnpm --filter ag-ui-langgraph run publish:check-name
pnpm --filter ag-ui-langgraph run publish:dry
```

`publish:dry` runs `npm pack --dry-run`; the real publish step is intentionally
left to the package owner.
