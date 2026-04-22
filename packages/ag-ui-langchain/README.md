# ag-ui-langchain

AG-UI protocol adapter for LangChain / LangGraph — TypeScript implementation aligned with the official Python [`ag-ui-langgraph`](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langgraph/python) package (v0.0.34).

## Features

| Feature | Python equivalent | Status |
|---|---|---|
| `toLangChainMessages` / `aguiMessagesToLangchain` | `agui_messages_to_langchain` | ✅ |
| `langchainMessagesToAgui` | `langchain_messages_to_agui` | ✅ |
| `convertLangchainMultimodalToAgui` | `convert_langchain_multimodal_to_agui` | ✅ |
| `convertAguiMultimodalToLangchain` | `convert_agui_multimodal_to_langchain` | ✅ |
| `eventsFromAIMessageStream` | (stream event conversion) | ✅ |
| `eventsFromToolMessage` / `toAIMessage` | (tool event helpers) | ✅ |
| `createAgentLoop` | `LangGraphAgent.run()` (single agent) | ✅ |
| `createSupervisorLoop` | `LangGraphAgent.run()` (supervisor) | ✅ |
| `makeJsonSafe` / `jsonSafeStringify` | `make_json_safe` / `json_safe_stringify` | ✅ |
| `resolveReasoningContent` | `resolve_reasoning_content` | ✅ |
| `resolveEncryptedReasoningContent` | `resolve_encrypted_reasoning_content` | ✅ |
| `resolveMessageContent` | `resolve_message_content` | ✅ |
| `flattenUserContent` | `flatten_user_content` | ✅ |
| `normalizeToolContent` | `normalize_tool_content` | ✅ |
| `LangGraphEventTypes` / `CustomEventNames` | `LangGraphEventTypes` / `CustomEventNames` | ✅ |
| All Python `types.py` types | `State`, `SchemaKeys`, `RunMetadata`, etc. | ✅ |

## Quick Start

### Single Agent

```ts
import { createAgentLoop } from "ag-ui-langchain";
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({ model: "gpt-4o" });

for await (const event of createAgentLoop(input, { model, tools })) {
  encoder.encode(event); // stream to client
}
```

### Supervisor + Sub-Agents

```ts
import { createSupervisorLoop } from "ag-ui-langchain";

for await (const event of createSupervisorLoop(input, {
  model,
  systemPrompt: "You are a supervisor...",
  subAgents: {
    researcher: { systemPrompt: "...", tools: researcherTools },
    writer: { systemPrompt: "...", tools: writerTools },
  },
})) {
  encoder.encode(event);
}
```

### Low-Level Stream Conversion

```ts
import {
  eventsFromAIMessageStream,
  eventsFromToolMessage,
  toAIMessage,
  withStreamEventMetadata,
} from "ag-ui-langchain";

// Convert a LangChain model stream to AG-UI events
const stream = await model.stream(messages);
const finalChunk = yield* eventsFromAIMessageStream(stream, metadata);
const message = toAIMessage(finalChunk);
```

### Message Conversion

```ts
import {
  toLangChainMessages,
  langchainMessagesToAgui,
} from "ag-ui-langchain";

// AG-UI → LangChain
const lcMessages = toLangChainMessages(aguiMessages);

// LangChain → AG-UI
const aguiMessages = langchainMessagesToAgui(lcMessages);
```

## Test Coverage

130 tests across 7 test suites covering:

- Message conversion (user, assistant, tool, system, developer)
- Multimodal round-trip (text, image URL, image data, binary)
- Stream conversion (text, tool calls, interleaved, metadata)
- Tool event emission
- JSON-safe serialization (primitives, cycles, Date, Set, Map, toJSON)
- Reasoning content resolution (Anthropic, LangChain, Bedrock, OpenAI, DeepSeek)
- Schema key filtering
- Type enum values
