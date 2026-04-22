# AG-UI Chat Demo

A best-practice demonstration of the [AG-UI Protocol](https://docs.ag-ui.com) with LangChain/LangGraph.
This project shows how to properly build an AI chat application using `@ag-ui/encoder`,
`@ag-ui/langchain`, backend tools, frontend tools (human-in-the-loop), and backend-managed
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
│              {messages, tools}          {messages + toolResult}      │
└─────────────────────┬───────────────────────────┬───────────────────┘
                      │         AG-UI SSE          │
                      ▼                            ▼
┌─────────────────────────────────────────────────────────────────────┐
│                         BACKEND (Hono + LangChain)                  │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  POST /api/agent                                            │    │
│  │                                                             │    │
│  │  1. Accept RunAgentInput (messages, tools, threadId)        │    │
│  │  2. @ag-ui/langchain LangChainAgent bridges events          │    │
│  │  3. @ag-ui/encoder encodes events as SSE                    │    │
│  │  4. Stream: RUN_STARTED -> TEXT_* / TOOL_* -> RUN_FINISHED  │    │
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

### 2. Using `@ag-ui/langchain` for LangChain Integration

The `LangChainAgent` class bridges LangChain's streaming output to AG-UI events.
It handles message conversion, tool call detection, and event emission.

```typescript
import { LangChainAgent } from "@ag-ui/langchain";

const agent = new LangChainAgent({
  chainFn: async ({ messages, tools }) => {
    return model.bindTools([...backendTools, ...tools]).stream(messages);
  },
});

const events$ = agent.run(input); // Returns Observable<BaseEvent>
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
    { messages: [...history, assistantMsg, toolResultMsg], tools: [...] }
  Server -> SSE Events:
    RUN_STARTED
    TEXT_MESSAGE_START / CONTENT ("Great! Deployment approved...")
    TEXT_MESSAGE_END
    RUN_FINISHED
```

### 5. Backend-Managed History

The backend automatically persists messages after each agent run:

1. Input messages (user/tool) that are not yet stored are saved
2. Assistant response is reconstructed from AG-UI events and saved
3. Frontend only reads (GET) and deletes (DELETE) -- never writes history directly

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
  │─── POST /api/agent ───────────>│── stream(msgs+result) ───>│
  │    {messages: [..., toolResult]}│<── text response ─────────│
  │                                │                           │
  │<── SSE: TEXT_MESSAGE_* ───────│                           │
  │<── SSE: RUN_FINISHED ─────────│  [persistHistory()]        │
```

## Setup

### Prerequisites

- Node.js 18+
- An OpenAI API key

### Installation

```bash
# Clone the repository
git clone https://github.com/Tsutomu-miku/ag-ui-chat-demo.git
cd ag-ui-chat-demo

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your OpenAI API key

# Start development (both server and client)
npm run dev
```

The server runs on `http://localhost:4000` and the client on `http://localhost:5173`.

### Running Individually

```bash
npm run dev:server  # Backend only (port 4000)
npm run dev:client  # Frontend only (port 5173, proxies /api to 4000)
```

## Project Structure

```
ag-ui-chat-demo/
├── package.json              # Workspace root
├── .env.example              # Environment template
├── .gitignore
├── README.md
├── server/
│   ├── package.json          # Server dependencies (@ag-ui/*, @langchain/*)
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts          # Hono server, AG-UI agent endpoint, history persistence
│       ├── agent.ts          # LangGraph agent, backend tools (weather, search, calc, time)
│       └── history.ts        # In-memory KV store, Hono router for history CRUD
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
| Bridge     | `@ag-ui/langchain`          | LangChain -> AG-UI event conversion        |
| LLM        | `@langchain/openai`         | OpenAI GPT-4o-mini                         |
| Agent      | `@langchain/langgraph`      | ReAct agent with tool loop                 |
| Server     | Hono + `@hono/node-server`  | HTTP server with SSE streaming             |
| Frontend   | React 19 + Vite             | Modern SPA with streaming UI               |
| Markdown   | `react-markdown` + remark   | Rich message rendering                     |
| Styling    | CSS custom properties       | Dark theme, responsive layout              |

## License

MIT
