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

## Public API

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

The npm package intentionally exposes only the root entrypoint:

```ts
import { createAgentEndpoint } from "ag-ui-hono";
```

Internal source files are not subpath exports. Treat imports such as
`ag-ui-hono/endpoint` as unsupported.

## Source Layout

The package is intentionally small:

```text
src/
  endpoint.ts  Hono endpoint factory, streaming, hooks, and error handling
  index.ts     root public exports
tests/
  endpoint.test.ts  endpoint behavior
  package/          npm publishing metadata and public export contract
```

Keep new implementation code in focused modules only when the endpoint grows
past a single responsibility.

## Testing

```bash
pnpm --filter ag-ui-hono run test
pnpm --filter ag-ui-hono run test:coverage
pnpm --filter ag-ui-hono run typecheck
```

The test suite covers app creation, health checks, invalid input, SSE event
encoding, input transformation, lifecycle hooks, handler failures, package
exports, and npm publishing metadata. `test:coverage` enforces global coverage
thresholds before publishing.

## Publishing

The npm package is emitted from `dist`:

```bash
pnpm --filter ag-ui-hono run typecheck
pnpm --filter ag-ui-hono run test:coverage
pnpm --filter ag-ui-hono run build
pnpm --filter ag-ui-hono run publish:check-name
pnpm --filter ag-ui-hono run publish:dry
```

The build script removes `dist` before compiling so deleted modules cannot leak
into the tarball. `publish:dry` runs `npm pack --dry-run`; the real publish step
is intentionally left to the package owner.
