# ag-ui-react

AG-UI protocol React hooks and state management utilities for building chat interfaces with agent support.

## Features

- **Pure state reducer**: `updateMessagesWithAgentEvent` — framework-agnostic, fully testable state machine
- **`useAgentChat` hook**: Wraps `@ag-ui/client` with AG-UI event subscription, frontend tool support
- **`useThreads` hook**: Thread CRUD + real-time event integration + step tracking for tree rendering
- **Full type definitions**: `ChatMessage`, `ChatThread`, `ThreadAgentEvent`, `ActiveStep`, etc.

## Quick Start

```tsx
import {
  useAgentChat,
  useThreads,
  updateMessagesWithAgentEvent,
} from "ag-ui-react";
import type { FrontendToolDefinition } from "ag-ui-react";

const MY_TOOLS: FrontendToolDefinition[] = [
  {
    name: "confirm_action",
    description: "Confirm an action",
    parameters: {
      type: "object",
      properties: { action: { type: "string" } },
    },
  },
];

function App() {
  const threads = useThreads({ historyApiUrl: "/api/history" });

  const { sendMessage, isStreaming, pendingToolCalls, resolveToolCall } =
    useAgentChat({
      agentUrl: "/api/agent",
      frontendTools: MY_TOOLS,
      onThreadEvent: threads.handleThreadEvent,
    });

  // threads.active?.messages contains the full conversation
  // threads.activeSteps tracks running sub-agents for tree display
}
```

## API

### `updateMessagesWithAgentEvent(messages, event)`

Pure function that applies a `ThreadAgentEvent` to a `ChatMessage[]` array. Handles all event types:

| Event | Effect |
|---|---|
| `assistant_start` | Creates/updates assistant message placeholder |
| `assistant_delta` | Appends text content |
| `assistant_end` | Clears streaming flag |
| `tool_start` | Adds tool call to parent message |
| `tool_args` | Appends argument delta |
| `tool_end` | Marks tool call complete |
| `append_message` | Adds message, marks parent tool call complete |
| `step_started/finished` | No-op (handled by step state) |
| `run_complete` | Clears all streaming flags |

### `useAgentChat(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `agentUrl` | `string` | `"/api/agent"` | AG-UI endpoint URL |
| `frontendTools` | `FrontendToolDefinition[]` | `[]` | Tools requiring user interaction |
| `onThreadEvent` | `(threadId, event) => void` | — | Event callback |
| `generateId` | `() => string` | `crypto.randomUUID` | ID generator |

Returns: `{ sendMessage, stopStreaming, resolveToolCall, isStreaming, pendingToolCalls }`

### `useThreads(options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `historyApiUrl` | `string` | `"/api/history"` | History API base URL |
| `generateId` | `() => string` | `crypto.randomUUID` | ID generator |

Returns: `{ list, active, activeId, activeSteps, create, select, remove, refreshList, appendMessage, handleThreadEvent, ... }`

## Test Coverage

37 tests across 2 test suites:
- **reducer.test.ts** (29 tests): All event types, edge cases, immutability, full integration scenarios, supervisor tree structure
- **types.test.ts** (8 tests): Type shape validation, discriminated union coverage
