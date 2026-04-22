# AG-UI Chat Demo

A best-practice demonstration of the [AG-UI Protocol](https://docs.ag-ui.com) with LangGraph.
This project shows how to properly build an AI chat application using `@ag-ui/encoder`,
`@langchain/langgraph`, backend tools, frontend tools (human-in-the-loop), and backend-managed
history persistence.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         FRONTEND (React + Vite)                     │
│                                                                     │
│  ┌──────────┐   ┌──────────────┐   ┌──────────────────────────┐    │
│  │ Sidebar   │   │  ChatPanel   │   │   FrontendToolUI         │    │
│  │ (threads) │   │  (messages)  │   │   (human-in-the-loop)    │    │
│  └──────────┘   └──────┬───────┘   └──────────┬───────────────┘    │
│                         │                       │                    │
│                    useAgentChat            resolveToolCall           │
│                         │                       │                    │
│                         ▼                       ▼                    │
│              POST /api/agent            POST /api/agent              │
│              {new messages, tools}      {toolResult, tools}          │
└─────────────────────┬───────────────────────────┬───────────────────┘
                      │         AG-UI SSE          │
                      ▼                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Hono + LangGraph)                  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  POST /api/agent                                            │    │
│  │                                                             │    │
│  │  1. Accept RunAgentInput (new messages, tools, threadId)    │    │
│  │  2. Hydrate prior thread messages from backend history      │    │
│  │  3. Local LangGraph agent runs model/tool/model loop        │    │
│  │  4. @ag-ui/encoder encodes events as SSE                    │    │
│  │  5. persistHistory() saves to in-memory KV store            │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌──────────────────┐   ┌──────────────────────────────────────┐    │
│  │  Backend Tools    │   │  History Store (in-memory Map)       │    │
│  │  - get_weather    │   │  GET  /api/history/threads           │    │
│  │  - search_web     │   │  GET  /api/history/threads/:id       │    │
│  │  - calculate      │   │  DELETE /api/history/threads/:id     │    │
│  │  - get_current_time│  └──────────────────────────────────────┘    │
│  └──────────────────┘                                               │
└─────────────────────────────────────────────────────────────────────┘
```

## AG-UI Protocol Best Practices

### 1. Using `@ag-ui/encoder` for SSE Encoding

The server uses `EventEncoder` from `@ag-ui/encoder` to properly encode AG-UI events
as Server-Sent Events. This ensures correct formatting and content-type negotiation.

```typescript
import { EventEncoder } from "@ag-ui/encoder";

const encoder = new EventEncoder({ accept: req.header("Accept") });
const encoded = encoder.encode(event); // Returns properly formatted SSE string
```

### 2. Using LangGraph for Tool Orchestration

The backend uses a local LangGraph graph so backend tools execute server-side and
their results are fed back into the model before the run finishes. Frontend tools are
bound as model-visible schemas, but the graph stops when one is requested so the UI
can collect human input before the next run.

```typescript
import { StateGraph, START, END, MessagesAnnotation } from "@langchain/langgraph";
import { ToolNode } from "@langchain/langgraph/prebuilt";

const toolNode = new ToolNode(backendTools);

const graph = new StateGraph(MessagesAnnotation)
  .addNode("agent", callModel)
  .addNode("tools", toolNode)
  .addEdge(START, "agent")
  .addConditionalEdges("agent", shouldContinue, { tools: "tools", [END]: END })
  .addEdge("tools", "agent")
  .compile();
```

### 3. Frontend Tools (Human-in-the-Loop)

The AG-UI protocol supports tools that execute on the **frontend** with user interaction:

- **Definition**: Frontend defines tools with JSON Schema parameters
- **Transmission**: Tools are sent to the agent via `RunAgentInput.tools`
- **Execution**: When the agent calls a frontend tool, `TOOL_CALL_*` events stream to the client
- **Resolution**: The frontend shows a UI, the user interacts, and a NEW request sends the result back

### 4. Multi-Turn Tool Call Flow

```
Turn 1: User asks to deploy production server
  Client -> POST /api/agent
    { messages: [userMsg], tools: [confirm_action, collect_user_input] }
  Server -> SSE Events:
    RUN_STARTED
    TEXT_MESSAGE_START / CONTENT ("I'll help you deploy...")
    TOOL_CALL_START  (confirm_action)
    TOOL_CALL_ARGS   ({"action": "Deploy production server", "severity": "high"})
    TOOL_CALL_END
    RUN_FINISHED

  Frontend shows confirmation dialog to user
  User clicks "Approve"

Turn 2: Frontend sends tool result
  Client -> POST /api/agent
    { messages: [toolResultMsg], tools: [...] }
  Server -> SSE Events:
    RUN_STARTED
    TEXT_MESSAGE_START / CONTENT ("Great! Deployment approved...")
    TEXT_MESSAGE_END
    RUN_FINISHED
```

### 5. Backend-Managed History

The backend hydrates prior messages by `threadId` before each agent run and persists new
messages after the run:

1. Stored thread messages are merged with the request's new messages for model context
2. Input messages (user/tool) that are not yet stored are saved
3. Assistant response is reconstructed from AG-UI events and saved
4. Frontend only reads (GET) and deletes (DELETE) -- never writes history directly

## Event Flow Diagrams

### Simple Text Response
```
Client                           Server
  │                                │
  │─── POST /api/agent ───────────>│
  │    {messages: [userMsg]}       │
  │                                │
  │<── SSE: RUN_STARTED ──────────│
  │<── SSE: TEXT_MESSAGE_START ───│
  │<── SSE: TEXT_MESSAGE_CONTENT ─│  (repeated, streamed)
  │<── SSE: TEXT_MESSAGE_END ─────│
  │<── SSE: RUN_FINISHED ─────────│
  │                                │
  │                          [persistHistory()]
```

### Backend Tool Call (Weather, Search, etc.)
```
Client                           Server                      LLM
  │                                │                           │
  │─── POST /api/agent ───────────>│                           │
  │                                │── stream(messages) ──────>│
  │                                │<── tool_call(get_weather) │
  │                                │                           │
  │<── SSE: TOOL_CALL_START ──────│  [execute get_weather()]   │
  │<── SSE: TOOL_CALL_ARGS ───────│                           │
  │<── SSE: TOOL_CALL_END ────────│── tool_result ────────────>│
  │<── SSE: TOOL_CALL_RESULT ─────│                           │
  │                                │<── text response ─────────│
  │<── SSE: TEXT_MESSAGE_* ───────│                           │
  │<── SSE: RUN_FINISHED ─────────│                           │
```

### Frontend Tool Call (Human-in-the-Loop)
```
Client                           Server                      LLM
  │                                │                           │
  │─── POST /api/agent ───────────>│── stream(messages) ──────>│
  │    {tools: [confirm_action]}   │<── tool_call(confirm)─────│
  │                                │                           │
  │<── SSE: TOOL_CALL_START ──────│                           │
  │<── SSE: TOOL_CALL_ARGS ───────│                           │
  │<── SSE: TOOL_CALL_END ────────│                           │
  │<── SSE: RUN_FINISHED ─────────│  [persistHistory()]        │
  │                                │                           │
  │  [Show confirmation UI]        │                           │
  │  [User clicks Approve]         │                           │
  │                                │                           │
  │─── POST /api/agent ───────────>│── stream(history+result) ─>│
  │    {messages: [toolResult]}    │<── text response ─────────│
  │                                │                           │
  │<── SSE: TEXT_MESSAGE_* ───────│                           │
  │<── SSE: RUN_FINISHED ─────────│  [persistHistory()]        │
```

## Setup

### Prerequisites

- Node.js 18+
- pnpm 10+
- An OpenAI or OpenRouter API key

### Installation

```bash
# Clone the repository
git clone https://github.com/Tsutomu-miku/ag-ui-chat-demo.git
cd ag-ui-chat-demo

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env and choose OpenAI or OpenRouter

# Start development (both server and client)
pnpm dev
```

The server runs on `http://localhost:4000` and the client on `http://localhost:5173`.
The backend loads environment variables from the workspace root `.env` and, optionally,
from `server/.env`.

### LLM Providers

OpenAI is the default provider:

```bash
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-your-openai-api-key-here
OPENAI_MODEL=gpt-4o-mini
```

To use OpenRouter:

```bash
LLM_PROVIDER=openrouter
OPENROUTER_API_KEY=sk-or-your-openrouter-api-key-here
OPENROUTER_MODEL=openai/gpt-4o-mini
```

Optional OpenRouter metadata can be set with `OPENROUTER_SITE_URL` and
`OPENROUTER_APP_NAME`.

### Running Individually

```bash
pnpm dev:server  # Backend only (port 4000)
pnpm dev:client  # Frontend only (port 5173, proxies /api to 4000)
```

### Backend Logging

Backend logs are ESM-friendly and include a source location such as
`server/src/http/middleware/requestLogger.ts:61:10`, so most terminals/editors can jump
back to the calling code. Request logs also include method, path, status, duration, and
`x-request-id`.

```bash
LOG_LEVEL=debug   # debug | info | warn | error
LOG_FORMAT=pretty # pretty | json
```

Run backend lint/type checks from the workspace root:

```bash
pnpm run lint
```

## Project Structure

```
ag-ui-chat-demo/
├── package.json              # Workspace root
├── pnpm-lock.yaml            # pnpm lockfile
├── pnpm-workspace.yaml       # pnpm workspace configuration
├── .env.example              # Environment template
├── .gitignore
├── README.md
├── server/
│   ├── package.json          # Server dependencies (@ag-ui/*, @langchain/*)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Server bootstrap
│       ├── app.ts            # Hono app, middleware, route mounting
│       ├── config/
│       │   └── llm.ts        # OpenAI/OpenRouter provider config
│       ├── http/
│       │   └── routes/
│       │       ├── agent.ts  # AG-UI SSE endpoint
│       │       ├── health.ts # Health check route
│       │       └── history.ts # History HTTP routes
│       └── services/
│           ├── agent/
│           │   ├── model.ts  # Chat model factory
│           │   └── tools.ts  # Backend tools
│           └── history/
│               ├── persistence.ts # AG-UI event -> stored message mapping
│               └── store.ts       # In-memory thread store
└── client/
    ├── package.json          # Client dependencies (React, @ag-ui/client, @ag-ui/core)
    ├── tsconfig.json
    ├── vite.config.ts        # Vite config with /api proxy
    ├── index.html
    └── src/
        ├── main.tsx          # Entry point
        ├── App.tsx           # Root component
        ├── types.ts          # Shared TypeScript types
        ├── hooks/
        │   ├── useThreads.ts    # Thread list management (read/delete from backend)
        │   └── useAgentChat.ts  # AG-UI SSE streaming, frontend tools, multi-turn
        ├── components/
        │   ├── Sidebar.tsx       # Thread list sidebar
        │   ├── ChatPanel.tsx     # Main chat interface
        │   ├── MessageBubble.tsx # Message rendering with Markdown
        │   ├── ToolCallDisplay.tsx # Tool call visualization (backend/frontend badges)
        │   └── FrontendToolUI.tsx  # Human-in-the-loop UI (confirm, input)
        └── styles/
            └── global.css       # Complete dark theme CSS
```

## Technology Stack

| Layer      | Technology                  | Purpose                                    |
|------------|-----------------------------|--------------------------------------------|  
| Protocol   | AG-UI                       | Agent-User Interaction protocol (SSE)      |
| Encoder    | `@ag-ui/encoder`            | SSE event encoding                         |
| Runtime    | `@langchain/langgraph`       | Model/tool/model orchestration             |
| LLM        | `@langchain/openai`         | OpenAI or OpenRouter chat models           |
| Tools      | LangChain tools             | Backend and frontend tool definitions      |
| Server     | Hono + `@hono/node-server`  | HTTP server with SSE streaming             |
| Frontend   | React 19 + Vite             | Modern SPA with streaming UI               |
| Markdown   | `react-markdown` + remark   | Rich message rendering                     |
| Styling    | CSS custom properties       | Dark theme, responsive layout              |

## License

MIT
