import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { createAgent } from "./agent.js";
import { historyRouter } from "./history.js";
import { v4 as uuid } from "uuid";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";

const app = new Hono();

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Accept"],
  })
);

// Health check
app.get("/api/health", (c) => c.json({ status: "ok" }));

// History API
app.route("/api/history", historyRouter);

// AG-UI Protocol endpoint
// Accepts POST with messages array, returns SSE stream of AG-UI events
app.post("/api/agent", async (c) => {
  const body = await c.req.json();
  const { threadId, runId, messages } = body;

  const currentThreadId = threadId || uuid();
  const currentRunId = runId || uuid();

  // Convert incoming messages to LangChain format
  const langchainMessages = (messages || []).map((msg: any) => {
    switch (msg.role) {
      case "user":
        return new HumanMessage(msg.content);
      case "assistant":
        return new AIMessage(msg.content);
      case "system":
        return new SystemMessage(msg.content);
      case "tool":
        return new ToolMessage({
          content: msg.content,
          tool_call_id: msg.toolCallId || "",
        });
      default:
        return new HumanMessage(msg.content);
    }
  });

  if (langchainMessages.length === 0) {
    return c.json({ error: "No messages provided" }, 400);
  }

  const agent = createAgent();

  return streamSSE(c, async (stream) => {
    try {
      // RUN_STARTED
      await stream.writeSSE({
        data: JSON.stringify({
          type: "RUN_STARTED",
          threadId: currentThreadId,
          runId: currentRunId,
        }),
      });

      const messageId = uuid();
      let hasStartedMessage = false;
      const currentToolCalls: Map<string, boolean> = new Map();

      // Stream the agent response using LangGraph's message-level streaming
      const agentStream = await agent.stream(
        { messages: langchainMessages },
        { streamMode: "messages" }
      );

      for await (const [message, _metadata] of agentStream) {
        // Handle AI message chunks (text content streaming)
        if (message._getType() === "ai") {
          const aiMsg = message as any;

          // Handle streamed text content
          if (
            aiMsg.content &&
            typeof aiMsg.content === "string" &&
            aiMsg.content.length > 0
          ) {
            if (!hasStartedMessage) {
              hasStartedMessage = true;
              await stream.writeSSE({
                data: JSON.stringify({
                  type: "TEXT_MESSAGE_START",
                  messageId,
                  role: "assistant",
                }),
              });
            }

            await stream.writeSSE({
              data: JSON.stringify({
                type: "TEXT_MESSAGE_CONTENT",
                messageId,
                delta: aiMsg.content,
              }),
            });
          }

          // Handle tool call chunks
          if (aiMsg.tool_call_chunks && aiMsg.tool_call_chunks.length > 0) {
            for (const toolCallChunk of aiMsg.tool_call_chunks) {
              const toolCallId =
                toolCallChunk.id || `tool_${toolCallChunk.index}`;

              if (toolCallChunk.name && !currentToolCalls.has(toolCallId)) {
                // Close any open text message before tool calls
                if (hasStartedMessage) {
                  await stream.writeSSE({
                    data: JSON.stringify({
                      type: "TEXT_MESSAGE_END",
                      messageId,
                    }),
                  });
                  hasStartedMessage = false;
                }

                currentToolCalls.set(toolCallId, true);
                await stream.writeSSE({
                  data: JSON.stringify({
                    type: "TOOL_CALL_START",
                    toolCallId,
                    toolCallName: toolCallChunk.name,
                  }),
                });
              }

              if (toolCallChunk.args) {
                await stream.writeSSE({
                  data: JSON.stringify({
                    type: "TOOL_CALL_ARGS",
                    toolCallId,
                    delta: toolCallChunk.args,
                  }),
                });
              }
            }
          }
        }

        // Handle tool result messages
        if (message._getType() === "tool") {
          const toolMsg = message as any;
          const toolCallId = toolMsg.tool_call_id;

          if (currentToolCalls.has(toolCallId)) {
            await stream.writeSSE({
              data: JSON.stringify({
                type: "TOOL_CALL_END",
                toolCallId,
              }),
            });
            currentToolCalls.delete(toolCallId);
          }
        }
      }

      // Close any remaining open text message
      if (hasStartedMessage) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "TEXT_MESSAGE_END",
            messageId,
          }),
        });
      }

      // Close any remaining open tool calls
      for (const [toolCallId] of currentToolCalls) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "TOOL_CALL_END",
            toolCallId,
          }),
        });
      }

      // RUN_FINISHED
      await stream.writeSSE({
        data: JSON.stringify({
          type: "RUN_FINISHED",
          threadId: currentThreadId,
          runId: currentRunId,
        }),
      });
    } catch (error: any) {
      console.error("Agent error:", error);
      await stream.writeSSE({
        data: JSON.stringify({
          type: "RUN_ERROR",
          message: error.message || "Unknown error",
        }),
      });
    }
  });
});

const port = Number(process.env.PORT || 4000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`AG-UI Server running at http://localhost:${info.port}`);
  console.log(
    `  AG-UI endpoint: POST http://localhost:${info.port}/api/agent`
  );
  console.log(
    `  History API:    http://localhost:${info.port}/api/history/threads`
  );
});
