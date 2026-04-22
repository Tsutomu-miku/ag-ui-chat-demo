import { EventEncoder } from "@ag-ui/encoder";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

import { createLogger } from "../../config/logger.js";
import { runLangGraphAgent } from "../../services/agent/langgraph.js";
import { buildMessagesWithHistory } from "../../services/history/context.js";
import { persistHistory } from "../../services/history/persistence.js";

export const agentRouter = new Hono();
const logger = createLogger("agent");

function durationSince(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

agentRouter.post("/", async (c) => {
  const startedAt = performance.now();
  let input: RunAgentInput;

  try {
    input = await c.req.json();
  } catch (error) {
    logger.warn("invalid agent request body", { error });

    return c.json({ error: "Invalid request body" }, 400);
  }

  const encoder = new EventEncoder({
    accept: c.req.header("Accept") || undefined,
  });
  const messages = buildMessagesWithHistory(input.threadId, input.messages);
  const runInput: RunAgentInput = { ...input, messages };

  logger.info("agent run accepted", {
    threadId: input.threadId,
    incomingMessageCount: input.messages.length,
    hydratedMessageCount: messages.length,
    frontendToolCount: input.tools?.length || 0,
  });

  const events: BaseEvent[] = [];

  return streamSSE(c, async (stream) => {
    const abortController = new AbortController();

    stream.onAbort(() => {
      abortController.abort();
      logger.warn("agent stream aborted", {
        threadId: input.threadId,
        eventCount: events.length,
        durationMs: durationSince(startedAt),
      });
    });

    try {
      for await (const event of runLangGraphAgent(
        runInput,
        abortController.signal,
      )) {
        if (abortController.signal.aborted) break;

        events.push(event);
        await stream.write(encoder.encode(event));
      }

      if (!abortController.signal.aborted) {
        persistHistory(input.threadId, input.messages, events);
        logger.info("agent run completed", {
          threadId: input.threadId,
          eventCount: events.length,
          durationMs: durationSince(startedAt),
        });
      }
    } catch (error) {
      logger.error("agent stream failed", {
        threadId: input.threadId,
        eventCount: events.length,
        durationMs: durationSince(startedAt),
        error,
      });

      if (events[events.length - 1]?.type !== EventType.RUN_ERROR) {
        const errorEvent: BaseEvent & { message: string } = {
          type: EventType.RUN_ERROR,
          message: error instanceof Error ? error.message : String(error),
        };

        events.push(errorEvent);
        await stream.write(encoder.encode(errorEvent));
      }

      persistHistory(input.threadId, input.messages, events);
    }
  });
});
