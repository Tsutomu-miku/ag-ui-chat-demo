# ag-ui-hono

AG-UI protocol HTTP endpoint adapter for [Hono](https://hono.dev/) — TypeScript equivalent of the Python [`add_langgraph_fastapi_endpoint`](https://github.com/ag-ui-protocol/ag-ui/tree/main/integrations/langgraph/python).

## Features

- **One-liner endpoint**: Wire any AG-UI agent handler into a Hono SSE endpoint
- **Lifecycle hooks**: `transformInput`, `onComplete`, `onError`, `onAbort`
- **Health check**: Built-in `GET /health` endpoint
- **EventEncoder**: Proper SSE encoding via `@ag-ui/encoder`
- **Error handling**: Automatic `RUN_ERROR` event on handler exceptions

## Quick Start

```ts
import { createAgentEndpoint } from "ag-ui-hono";
import { LangGraphAgent } from "ag-ui-langgraph";

const agent = new LangGraphAgent({ name: "agent", graph });

// Create the endpoint
const agentApp = createAgentEndpoint(
  (input, signal) => agent.clone().run(input),
  {
    transformInput: (input) => ({
      ...input,
      messages: hydrateHistory(input.threadId, input.messages),
    }),
    onComplete: (threadId, msgs, events) => {
      persistHistory(threadId, msgs, events);
    },
    logger: myLogger,
  },
);

// Mount on your Hono app
app.route("/api/agent", agentApp);
```

## API

### `createAgentEndpoint(handler, options?)`

| Parameter | Type | Description |
|---|---|---|
| `handler` | `(input: RunAgentInput, signal: AbortSignal) => AsyncGenerator<BaseEvent>` | Your agent handler |
| `options.transformInput` | `(input) => input` | Pre-process input (e.g. hydrate history) |
| `options.onComplete` | `(threadId, messages, events) => void` | Called after successful stream |
| `options.onError` | `(threadId, error, events) => void` | Called on handler exception |
| `options.onAbort` | `(threadId, events) => void` | Called when client disconnects |
| `options.logger` | `{ info, warn, error }` | Optional structured logger |

Returns a `Hono` app with:
- `POST /` — Agent endpoint (accepts `RunAgentInput` JSON, streams SSE)
- `GET /health` — Health check (`{ status: "ok" }`)

## Test Coverage

8 tests covering: app creation, health endpoint, input validation, SSE streaming, input transformation, completion hooks, error hooks.
