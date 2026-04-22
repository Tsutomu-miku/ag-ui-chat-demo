import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { EventEncoder } from "@ag-ui/encoder";
import { LangChainAgent } from "@ag-ui/langchain";
import { EventType } from "@ag-ui/core";
import type { RunAgentInput, BaseEvent } from "@ag-ui/core";
import { createAgentModel, backendTools } from "./agent.js";
import {
  historyRouter,
  getOrCreateThread,
  appendMessages,
  type StoredMessage,
} from "./history.js";
import { v4 as uuid } from "uuid";

const app = new Hono();

// ============================================================
// Middleware
// ============================================================

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["*"],
  })
);

// ============================================================
// Health check
// ============================================================

app.get("/api/health", (c) => c.json({ status: "ok", timestamp: new Date().toISOString() }));

// ============================================================
// History API (read/delete only - writing is done by the agent endpoint)
// ============================================================

app.route("/api/history", historyRouter);

// ============================================================
// AG-UI Agent Endpoint
//
// This is the core of the AG-UI best practice:
// 1. Accept RunAgentInput (POST with messages, tools, threadId, etc.)
// 2. Use @ag-ui/langchain's LangChainAgent to bridge LangChain -> AG-UI events
// 3. Use @ag-ui/encoder to encode events as SSE
// 4. Stream events back to the client
// 5. After run completes, persist messages to history
//
// Frontend tools flow:
// - Client sends tools[] in RunAgentInput
// - @ag-ui/langchain converts them to LangChain DynamicStructuredTools (with no-op func)
// - When the LLM calls a frontend tool, TOOL_CALL_* events are emitted
// - The run finishes (RUN_FINISHED)
// - Client executes the tool locally (e.g., shows a confirmation dialog)
// - Client sends a NEW request with the tool result as a ToolMessage in messages[]
// - The agent continues processing with the tool result
// ============================================================

app.post("/api/agent", async (c) => {
  const input: RunAgentInput = await c.req.json();
  const encoder = new EventEncoder({ accept: c.req.header("Accept") || undefined });

  // Ensure thread exists
  getOrCreateThread(input.threadId);

  // ----- Build the LangChainAgent -----
  // Using chainFn pattern for full control:
  // - We use createReactAgent from LangGraph for BACKEND tools
  // - @ag-ui/langchain automatically handles FRONTEND tools (from input.tools)
  //   by converting them to LangChain tools with no-op func
  const agent = new LangChainAgent({
    chainFn: async ({ messages, tools, threadId, runId }) => {
      const model = createAgentModel();

      // Merge backend tools + frontend tools (passed via AG-UI protocol)
      // Backend tools have real implementations; frontend tools have no-op func
      const allTools = [...backendTools, ...tools];

      // Bind all tools to the model and stream
      return model.bindTools(allTools).stream(messages);
    },
  });

  // ----- Collect events for history persistence -----
  const collectedEvents: (BaseEvent & Record<string, any>)[] = [];

  // ----- Stream SSE response -----
  const contentType = encoder.getContentType();

  const events$ = agent.run(input);

  return streamSSE(c, async (stream) => {
    await new Promise<void>((resolve, reject) => {
      const subscription = events$.subscribe({
        next: (event) => {
          collectedEvents.push(event as any);
          // Use @ag-ui/encoder to properly encode the event
          const encoded = encoder.encode(event);
          // streamSSE expects writeSSE with data field, but we need raw SSE
          // So we write the raw encoded string directly
          stream.write(encoded);
        },
        error: (err) => {
          console.error("[AG-UI] Stream error:", err);
          const errorEvent = {
            type: EventType.RUN_ERROR,
            message: err instanceof Error ? err.message : String(err),
          };
          stream.write(encoder.encode(errorEvent as any));
          // Still try to save what we have
          persistHistory(input.threadId, input.messages, collectedEvents);
          resolve();
        },
        complete: () => {
          // ----- Persist history after run completes -----
          persistHistory(input.threadId, input.messages, collectedEvents);
          resolve();
        },
      });

      stream.onAbort(() => {
        subscription.unsubscribe();
        resolve();
      });
    });
  });
});

// ============================================================
// History Persistence Logic
//
// After each agent run, we reconstruct the assistant's response
// from the collected AG-UI events and save it to the thread.
// We also save any NEW user/tool messages that aren't already stored.
// ============================================================

function persistHistory(
  threadId: string,
  inputMessages: any[],
  events: (BaseEvent & Record<string, any>)[]
) {
  const thread = getOrCreateThread(threadId);
  const existingIds = new Set(thread.messages.map((m) => m.id));
  const newMessages: StoredMessage[] = [];

  // 1. Save input messages that are not yet in the thread
  //    (user messages and tool result messages from the client)
  for (const msg of inputMessages) {
    if (msg.id && !existingIds.has(msg.id)) {
      newMessages.push({
        id: msg.id,
        role: msg.role,
        content: msg.content || "",
        toolCallId: msg.toolCallId,
        toolCalls: msg.toolCalls,
        createdAt: new Date().toISOString(),
      });
      existingIds.add(msg.id);
    }
  }

  // 2. Reconstruct assistant message from AG-UI events
  let assistantContent = "";
  let currentMessageId = "";
  const toolCalls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  const toolCallArgs = new Map<string, string>();

  for (const event of events) {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
      case "TEXT_MESSAGE_START":
        currentMessageId = event.messageId || uuid();
        break;
      case EventType.TEXT_MESSAGE_CONTENT:
      case "TEXT_MESSAGE_CONTENT":
        assistantContent += event.delta || "";
        break;
      case EventType.TOOL_CALL_START:
      case "TOOL_CALL_START":
        toolCalls.push({
          id: event.toolCallId,
          type: "function",
          function: { name: event.toolCallName, arguments: "" },
        });
        toolCallArgs.set(event.toolCallId, "");
        break;
      case EventType.TOOL_CALL_ARGS:
      case "TOOL_CALL_ARGS":
        const prev = toolCallArgs.get(event.toolCallId) || "";
        const updated = prev + (event.delta || "");
        toolCallArgs.set(event.toolCallId, updated);
        const tc = toolCalls.find((t) => t.id === event.toolCallId);
        if (tc) tc.function.arguments = updated;
        break;
    }
  }

  // Only save if there's actual content or tool calls
  if (assistantContent || toolCalls.length > 0) {
    newMessages.push({
      id: currentMessageId || uuid(),
      role: "assistant",
      content: assistantContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      createdAt: new Date().toISOString(),
    });
  }

  if (newMessages.length > 0) {
    appendMessages(threadId, newMessages);
  }
}

// ============================================================
// Start Server
// ============================================================

const port = Number(process.env.PORT || 4000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`\n🚀 AG-UI Chat Server running at http://localhost:${info.port}`);
  console.log(`   ├─ AG-UI Agent:  POST http://localhost:${info.port}/api/agent`);
  console.log(`   ├─ History API:  GET  http://localhost:${info.port}/api/history/threads`);
  console.log(`   └─ Health:       GET  http://localhost:${info.port}/api/health\n`);
});
