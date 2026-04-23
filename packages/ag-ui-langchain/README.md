# ag-ui-langchain

AG-UI protocol adapter for LangChain / LangGraph — TypeScript implementation aligned with the official Python [`ag-ui-langgraph`](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langgraph/python) package (v0.0.34).

## Quick Start

### Single Agent (recommended)

```ts
import { createReactAgent } from "ag-ui-langchain";
import { ChatOpenAI } from "@langchain/openai";

const agent = createReactAgent({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  tools: [searchWeb, calculate],
  systemPrompt: "You are a helpful assistant.",
});

// In your endpoint handler — clone() per request for isolation:
for await (const event of agent.clone().run(input, signal)) {
  encoder.encode(event);
}
```

### Supervisor + Sub-Agents (recommended)

```ts
import { createSupervisor } from "ag-ui-langchain";

const agent = createSupervisor({
  model: new ChatOpenAI({ model: "gpt-4o" }),
  systemPrompt: "You are a supervisor that delegates work.",
  subAgents: {
    researcher: { systemPrompt: "You research topics.", tools: [searchWeb] },
    writer:     { systemPrompt: "You write content.",   tools: [writeDoc] },
  },
});

// Same pattern — clone + run:
for await (const event of agent.clone().run(input, signal)) {
  encoder.encode(event);
}
```

### With ag-ui-hono Endpoint (one-liner)

```ts
import { createReactAgent } from "ag-ui-langchain";
import { createAgentEndpoint } from "ag-ui-hono";

const agent = createReactAgent({ model, tools, systemPrompt: "..." });
const app = createAgentEndpoint((input, signal) => agent.clone().run(input, signal));
```

## API Reference

### Agent Classes

| Class | Description |
|---|---|
| `LangGraphAgent` | Core agent adapter with `clone()` / `run()` — aligned with Python `LangGraphAgent` |
| `SupervisorAgent` | Multi-agent supervisor variant, extends `LangGraphAgent` |

### Factory Functions

| Function | Returns | Description |
|---|---|---|
| `createReactAgent(config)` | `LangGraphAgent` | Create a single-agent with tools |
| `createSupervisor(config)` | `SupervisorAgent` | Create a supervisor coordinating sub-agents |

### Configuration Types

```ts
interface LangGraphAgentConfig {
  name?: string;                                      // Display name
  model: BaseChatModel;                               // LangChain chat model
  tools?: Parameters<BaseChatModel["bindTools"]>[0];  // Backend tools
  systemPrompt?: string;                              // System prompt
  maxIterations?: number;                             // Max loop iterations (default: 10)
}

interface SubAgentDefinition {
  systemPrompt: string;                               // Sub-agent system prompt
  tools: Parameters<BaseChatModel["bindTools"]>[0];   // Sub-agent tools
  model?: BaseChatModel;                              // Optional model override
}

interface SupervisorConfig extends LangGraphAgentConfig {
  subAgents: Record<string, SubAgentDefinition>;      // Sub-agents keyed by name
}
```

### Low-Level Loop Functions

For advanced use cases where you need direct control:

```ts
import { createAgentLoop, createSupervisorLoop } from "ag-ui-langchain";

// These accept the same config types and return AsyncGenerator<BaseEvent>
yield* createAgentLoop(input, config, signal);
yield* createSupervisorLoop(input, supervisorConfig, signal);
```

### Stream & Message Utilities

```ts
import {
  eventsFromAIMessageStream,  // LangChain model stream → AG-UI events
  eventsFromToolMessage,       // ToolMessage → TOOL_CALL_RESULT event
  toAIMessage,                 // AIMessageChunk → AIMessage
  withStreamEventMetadata,     // Attach step metadata to events
  toLangChainMessages,         // AG-UI messages → LangChain messages
  langchainMessagesToAgui,     // LangChain messages → AG-UI messages
} from "ag-ui-langchain";
```

## Features — Python Alignment

| Feature | Python equivalent | Status |
|---|---|---|
| `LangGraphAgent` / `createReactAgent` | `LangGraphAgent(graph=...)` | ✅ |
| `SupervisorAgent` / `createSupervisor` | `LangGraphAgent` with sub-agents | ✅ |
| `clone()` / `run()` | `clone()` / `run()` | ✅ |
| `toLangChainMessages` | `agui_messages_to_langchain` | ✅ |
| `langchainMessagesToAgui` | `langchain_messages_to_agui` | ✅ |
| `convertLangchainMultimodalToAgui` | `convert_langchain_multimodal_to_agui` | ✅ |
| `convertAguiMultimodalToLangchain` | `convert_agui_multimodal_to_langchain` | ✅ |
| `eventsFromAIMessageStream` | stream event conversion | ✅ |
| `eventsFromToolMessage` / `toAIMessage` | tool event helpers | ✅ |
| `makeJsonSafe` / `jsonSafeStringify` | `make_json_safe` / `json_safe_stringify` | ✅ |
| `resolveReasoningContent` | `resolve_reasoning_content` | ✅ |
| `resolveEncryptedReasoningContent` | `resolve_encrypted_reasoning_content` | ✅ |
| `resolveMessageContent` | `resolve_message_content` | ✅ |
| `flattenUserContent` | `flatten_user_content` | ✅ |
| `normalizeToolContent` | `normalize_tool_content` | ✅ |
| `LangGraphEventTypes` / `CustomEventNames` | `LangGraphEventTypes` / `CustomEventNames` | ✅ |
| All Python `types.py` types | `State`, `SchemaKeys`, `RunMetadata`, etc. | ✅ |

## Test Coverage

155 tests across 8 test suites:

- **agent.test.ts** (25) — LangGraphAgent, SupervisorAgent, factories, clone/run lifecycle, delegation, abort signals
- **convert.test.ts** (69) — Message conversion, multimodal round-trip, content utilities
- **stream.test.ts** (9) — AI message stream → AG-UI events, tool call streaming, metadata
- **tools.test.ts** (6) — Tool result events, AIMessage conversion
- **make-json-safe.test.ts** (21) — JSON-safe serialization (primitives, cycles, Date, Set, Map)
- **reasoning.test.ts** (15) — Reasoning content resolution (Anthropic, LangChain, Bedrock, OpenAI, DeepSeek)
- **schema-keys.test.ts** (6) — Schema key filtering
- **types.test.ts** (4) — Enum values and type structure
