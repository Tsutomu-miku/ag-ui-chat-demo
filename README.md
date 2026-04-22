# AG-UI Chat Demo

A complete, best-practice demonstration of the **AG-UI (Agent User Interaction) protocol** — an open standard that enables seamless, streaming communication between AI agents and frontend applications.

This monorepo contains a **Hono + LangGraph** backend that speaks the AG-UI event protocol over SSE, and a **Vite + React** frontend that consumes those events to render a real-time chat experience with tool-call visualization.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        FRONTEND                             │
│  Vite + React 19                                            │
│  ┌──────────┐  ┌────────────────────────────────────────┐   │
│  │ Sidebar   │  │  ChatPanel                             │   │
│  │ (threads) │  │  ┌──────────────────────────────────┐  │   │
│  │           │  │  │ MessageBubble (markdown)         │  │   │
│  │           │  │  │ ToolCallDisplay (live args)      │  │   │
│  │           │  │  │ Typing indicator                 │  │   │
│  │           │  │  └──────────────────────────────────┘  │   │
│  └──────────┘  └────────────────────────────────────────┘   │
│        │                        │                           │
│        │  useThreads()          │  useAgentChat()           │
│        │  (history CRUD)        │  (AG-UI SSE stream)       │
└────────┼────────────────────────┼───────────────────────────┘
         │ REST                   │ SSE (AG-UI Protocol)
         ▼                        ▼
┌─────────────────────────────────────────────────────────────┐
│                        BACKEND                              │
│  Hono + Node.js                                             │
│                                                             │
│  POST /api/agent  ──►  AG-UI SSE handler                    │
│       │                     │                               │
│       │              ┌──────▼──────┐                        │
│       │              │  LangGraph  │                        │
│       │              │  ReAct Agent │                       │
│       │              │  (GPT-4o)   │                        │
│       │              └──────┬──────┘                        │
│       │                     │                               │
│       │              ┌──────▼──────┐                        │
│       │              │   Tools     │                        │
│       │              │ • weather   │                        │
│       │              │ • search    │                        │
│       │              │ • calculate │                        │
│       │              │ • time      │                        │
│       │              └─────────────┘                        │
│       │                                                     │
│  /api/history/*  ──►  In-memory KV store                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## AG-UI Protocol Overview

The AG-UI protocol defines a set of **Server-Sent Events (SSE)** that an agent backend emits so that any compliant frontend can render a rich, streaming chat experience. The key events used in this demo are:

| Event                  | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `RUN_STARTED`          | Signals the beginning of an agent run               |
| `TEXT_MESSAGE_START`   | Opens a new assistant text message                  |
| `TEXT_MESSAGE_CONTENT` | Streams a delta (chunk) of text content             |
| `TEXT_MESSAGE_END`     | Closes the current text message                     |
| `TOOL_CALL_START`      | Signals the agent is invoking a tool                |
| `TOOL_CALL_ARGS`       | Streams the JSON arguments for a tool call          |
| `TOOL_CALL_END`        | Signals the tool call is complete                   |
| `RUN_FINISHED`         | Signals the agent run has completed                 |
| `RUN_ERROR`            | Signals an error occurred during the run            |

### Event Flow Example

```
Client                              Server
  │                                    │
  │  POST /api/agent {messages}        │
  │───────────────────────────────────►│
  │                                    │
  │  SSE: RUN_STARTED                  │
  │◄───────────────────────────────────│
  │  SSE: TOOL_CALL_START (weather)    │
  │◄───────────────────────────────────│
  │  SSE: TOOL_CALL_ARGS {"city":...}  │
  │◄───────────────────────────────────│
  │  SSE: TOOL_CALL_END                │
  │◄───────────────────────────────────│
  │  SSE: TEXT_MESSAGE_START           │
  │◄───────────────────────────────────│
  │  SSE: TEXT_MESSAGE_CONTENT "The.." │
  │◄───────────────────────────────────│
  │  SSE: TEXT_MESSAGE_CONTENT "wea.." │
  │◄───────────────────────────────────│
  │  SSE: TEXT_MESSAGE_END             │
  │◄───────────────────────────────────│
  │  SSE: RUN_FINISHED                 │
  │◄───────────────────────────────────│
```

---

## Quick Start

### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- An **OpenAI API key** (GPT-4o-mini is used by default)

### 1. Clone the repository

```bash
git clone https://github.com/Tsutomu-miku/ag-ui-chat-demo.git
cd ag-ui-chat-demo
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

```bash
cp .env.example .env
# Edit .env and add your OpenAI API key
```

### 4. Start development servers

```bash
npm run dev
```

This starts both:
- **Server** on `http://localhost:4000` (Hono + LangGraph)
- **Client** on `http://localhost:5173` (Vite + React)

The Vite dev server proxies `/api/*` requests to the backend automatically.

---

## Project Structure

```
ag-ui-chat-demo/
├── package.json          # Root workspace config
├── .env.example          # Environment variable template
├── .gitignore
├── README.md
│
├── server/               # Backend — Hono + LangGraph
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts      # Hono server, CORS, routes, SSE streaming
│       ├── agent.ts      # LangGraph ReAct agent with tools
│       └── history.ts    # In-memory chat history API
│
└── client/               # Frontend — Vite + React
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    └── src/
        ├── main.tsx
        ├── App.tsx
        ├── hooks/
        │   ├── useThreads.ts     # Thread/history CRUD hook
        │   └── useAgentChat.ts   # AG-UI SSE streaming hook
        ├── components/
        │   ├── Sidebar.tsx        # Thread list sidebar
        │   ├── ChatPanel.tsx      # Main chat interface
        │   ├── MessageBubble.tsx  # Markdown message rendering
        │   └── ToolCallDisplay.tsx # Tool call visualization
        └── styles/
            └── global.css        # Dark theme, responsive layout
```

---

## Available Agent Tools

The LangGraph ReAct agent has four demo tools:

| Tool               | Description                                        |
| ------------------ | -------------------------------------------------- |
| `get_weather`      | Returns mock weather data for a given city          |
| `search_web`       | Returns mock search results for a query             |
| `calculate`        | Evaluates mathematical expressions                  |
| `get_current_time` | Returns the current date, time, and timezone        |

Try prompts like:
- *"What's the weather in Tokyo and Paris?"*
- *"Search for the latest news about AI agents"*
- *"What is 42 * 17 + 256 / 8?"*
- *"What time is it right now?"*

---

## Technology Stack

### Backend

| Technology             | Role                                             |
| ---------------------- | ------------------------------------------------ |
| **Hono**               | Ultra-fast web framework with SSE streaming      |
| **@hono/node-server**  | Node.js HTTP adapter for Hono                    |
| **LangGraph**          | Graph-based agent orchestration                  |
| **LangChain**          | LLM integration and tool framework               |
| **ChatOpenAI**         | GPT-4o-mini model (streaming)                    |
| **Zod**                | Runtime type validation for tool schemas         |
| **TypeScript + tsx**   | Type-safe development with hot reload            |

### Frontend

| Technology             | Role                                             |
| ---------------------- | ------------------------------------------------ |
| **React 19**           | UI framework                                     |
| **Vite 6**             | Lightning-fast dev server and bundler             |
| **react-markdown**     | Markdown rendering for assistant messages         |
| **remark-gfm**         | GitHub Flavored Markdown support (tables, etc.)   |
| **AG-UI Client**       | AG-UI protocol types and utilities                |
| **TypeScript**         | Full type safety                                  |

### Protocol

| Technology             | Role                                             |
| ---------------------- | ------------------------------------------------ |
| **AG-UI Protocol**     | Open standard for agent-frontend communication   |
| **Server-Sent Events** | Unidirectional streaming transport                |

---

## API Endpoints

| Method | Path                          | Description                     |
| ------ | ----------------------------- | ------------------------------- |
| POST   | `/api/agent`                  | AG-UI agent endpoint (SSE)      |
| GET    | `/api/health`                 | Health check                    |
| GET    | `/api/history/threads`        | List all chat threads           |
| POST   | `/api/history/threads`        | Create a new thread             |
| GET    | `/api/history/threads/:id`    | Get a thread with messages      |
| POST   | `/api/history/threads/:id/messages` | Add messages to a thread  |
| DELETE | `/api/history/threads/:id`    | Delete a thread                 |

---

## License

MIT
