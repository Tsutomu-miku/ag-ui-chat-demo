# ag-ui-langchain

AG-UI protocol adapter for LangChain / LangGraph — TypeScript implementation **truly aligned** with the official Python [`ag-ui-langgraph`](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langgraph/python) package (v0.0.34).

## Architecture (aligned with Python)

The core `LangGraphAgent` class accepts a **compiled LangGraph state graph** and translates its internal execution events via `graph.streamEvents(version: "v2")` into AG-UI protocol events. This is the **same architecture** as the Python package:

```
Python:  LangGraphAgent(graph=compiled_graph)  →  graph.astream_events(v2)  →  AG-UI events
     TS: LangGraphAgent({ graph: compiledGraph }) →  graph.streamEvents(v2)  →  AG-UI events
```

## Quick Start

### Option 1: Direct graph wrapping (most aligned with Python)

```ts
import { LangGraphAgent } from "ag-ui-langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

// Build a LangGraph compiled graph (exactly like Python)
const graph = createReactAgent({ llm: model, tools: [searchWeb, calculate] });

// Wrap in LangGraphAgent — same as Python: LangGraphAgent(graph=graph, name="my-agent")
const agent = new LangGraphAgent({ name: "my-agent", graph });

// Per-request: clone() for isolation, run() for event stream
for await (const event of agent.clone().run(input)) {
  encoder.encode(event);
}
```

### Option 2: Factory helpers (convenience)

```ts
import { createReactAgent, createSupervisor } from "ag-ui-langchain";

// Single agent — builds a LangGraph graph internally
const agent = createReactAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [searchWeb, calculate],
  systemPrompt: "You are a helpful assistant.",
});

// Supervisor — same pattern
const supervisor = createSupervisor({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  subAgents: {
    researcher: { systemPrompt: "...", tools: [searchWeb] },
    writer:     { systemPrompt: "...", tools: [writeDoc] },
  },
});

// Same usage for both:
for await (const event of agent.clone().run(input)) { ... }
```

### With ag-ui-hono endpoint

```ts
import { LangGraphAgent } from "ag-ui-langchain";
import { createAgentEndpoint } from "ag-ui-hono";

const agent = new LangGraphAgent({ name: "agent", graph });
const app = createAgentEndpoint((input) => agent.clone().run(input));
```

## Event Translation (LangGraph → AG-UI)

The core value of this package: translating LangGraph's internal execution events into the AG-UI protocol.

| LangGraph Event | AG-UI Event(s) |
|---|---|
| `on_chat_model_stream` (text) | `TEXT_MESSAGE_START` → `TEXT_MESSAGE_CONTENT` |
| `on_chat_model_stream` (tool call) | `TOOL_CALL_START` → `TOOL_CALL_ARGS` |
| `on_chat_model_end` | `TEXT_MESSAGE_END` or `TOOL_CALL_END` |
| `on_tool_end` | `TOOL_CALL_RESULT` (+ start/args/end if not streamed) |
| `on_tool_error` | (resets internal flags) |
| `on_custom_event` / `manually_emit_message` | `TEXT_MESSAGE_START/CONTENT/END` + `CUSTOM` |
| `on_custom_event` / `manually_emit_tool_call` | `TOOL_CALL_START/ARGS/END` + `CUSTOM` |
| `on_custom_event` / `manually_emit_state` | `STATE_SNAPSHOT` + `CUSTOM` |
| Node changes (via metadata) | `STEP_FINISHED` → `STEP_STARTED` |
| Stream start/end | `RUN_STARTED` / `RUN_FINISHED` |
| Reasoning content | `REASONING_START/CONTENT/END` |

## API Reference

### Core Class

```ts
class LangGraphAgent {
  constructor(config: LangGraphAgentConfig);
  clone(): LangGraphAgent;             // Fresh copy per request
  run(input: RunAgentInput): AsyncGenerator<BaseEvent>;
}
```

### Configuration

```ts
interface LangGraphAgentConfig {
  name: string;                              // Agent name
  graph: CompiledStateGraph<any, any, any>;  // Compiled LangGraph graph
  description?: string;
  config?: Record<string, unknown>;          // Runnable config
}
```

### Factory Functions

| Function | Returns | Description |
|---|---|---|
| `createReactAgent(config)` | `LangGraphAgent` | Builds a prebuilt react agent graph, wraps in LangGraphAgent |
| `createSupervisor(config)` | `LangGraphAgent` | Builds a supervisor graph, wraps in LangGraphAgent |

## Python Alignment

| Feature | Python `ag_ui_langgraph` | TS `ag-ui-langchain` | Status |
|---|---|---|---|
| `LangGraphAgent(graph=...)` | ✅ | `new LangGraphAgent({ graph })` | ✅ |
| `clone()` / `run()` | ✅ | ✅ | ✅ |
| `graph.astream_events(v2)` event translation | ✅ | `graph.streamEvents(v2)` | ✅ |
| `on_chat_model_stream` → text/tool events | ✅ | ✅ | ✅ |
| `on_chat_model_end` → cleanup | ✅ | ✅ | ✅ |
| `on_tool_end` → TOOL_CALL_RESULT | ✅ | ✅ | ✅ |
| `on_tool_error` → flag reset | ✅ | ✅ | ✅ |
| `on_custom_event` dispatch | ✅ | ✅ | ✅ |
| Node change → STEP events | ✅ | ✅ | ✅ |
| Reasoning event lifecycle | ✅ | ✅ | ✅ |
| Message-in-progress tracking | ✅ | ✅ | ✅ |
| Subgraph boundary detection | ✅ | ⚠️ Best-effort | Partial |
| Time-travel / Regeneration | ✅ | ❌ | Future |
| Interrupt handling (Command resume) | ✅ | ❌ | Future |
| State/Messages snapshots | ✅ | ❌ | Future |
| Predict-state suppression | ✅ | ❌ | Future |
| `add_langgraph_fastapi_endpoint` | ✅ | `createAgentEndpoint` (ag-ui-hono) | ✅ |
| `StateStreamingMiddleware` | ✅ | ❌ | Future |
| Message conversion (utils.py) | ✅ | ✅ | ✅ |
| All types (types.py) | ✅ | ✅ | ✅ |
| `make_json_safe` / `json_safe_stringify` | ✅ | ✅ | ✅ |
| Reasoning resolution (5 formats) | ✅ | ✅ | ✅ |

## Test Coverage

151 tests across 8 test suites:

- **agent.test.ts** (21) — LangGraphAgent graph-based event translation, text streaming, tool calls, step management, custom events, tool errors, full loop integration
- **convert.test.ts** (69) — Message conversion, multimodal round-trip, content utilities
- **stream.test.ts** (9) — AI message stream → AG-UI events, tool call streaming, metadata
- **tools.test.ts** (6) — Tool result events, AIMessage conversion
- **make-json-safe.test.ts** (21) — JSON-safe serialization
- **reasoning.test.ts** (15) — Reasoning content resolution (5 provider formats)
- **schema-keys.test.ts** (6) — Schema key filtering
- **types.test.ts** (4) — Enum values and type structure
