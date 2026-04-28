/**
 * AG-UI HTTP endpoint adapter for Hono.
 *
 * TypeScript equivalent of Python `add_langgraph_fastapi_endpoint`.
 * Provides a generic `createAgentEndpoint` that wires any AG-UI agent
 * handler into a Hono SSE endpoint.
 */

import { EventEncoder } from "@ag-ui/encoder";
import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

// ── Types ──

/**
 * An AG-UI agent handler: receives parsed input + abort signal,
 * yields AG-UI events.
 */
export type AgentHandler = (
  input: RunAgentInput,
  signal: AbortSignal,
) => AsyncGenerator<BaseEvent> | AsyncIterable<BaseEvent>;

/**
 * Optional hooks for customizing endpoint behaviour.
 */
export interface EndpointOptions {
  /** Transform input before passing to the handler (e.g. hydrate history) */
  transformInput?: (
    input: RunAgentInput,
  ) => RunAgentInput | Promise<RunAgentInput>;
  /** Called after a successful run with the collected events */
  onComplete?: (
    threadId: string,
    inputMessages: RunAgentInput["messages"],
    events: BaseEvent[],
    runInput: RunAgentInput,
  ) => void | Promise<void>;
  /** Called when the stream errors */
  onError?: (
    threadId: string,
    error: unknown,
    events: BaseEvent[],
    runInput: RunAgentInput,
  ) => void | Promise<void>;
  /** Called when the client aborts */
  onAbort?: (
    threadId: string,
    events: BaseEvent[],
    runInput: RunAgentInput,
  ) => void | Promise<void>;
  /** Optional logger */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
    error: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

// ── Endpoint factory ──

/**
 * Create a Hono sub-app that exposes an AG-UI agent as a POST endpoint.
 *
 * Aligned with Python `add_langgraph_fastapi_endpoint`:
 * - Parses `RunAgentInput` from request body
 * - Creates `EventEncoder` with the request's Accept header
 * - Streams SSE events from the agent handler
 * - Provides health check at GET /health
 *
 * @param handler - The agent handler function
 * @param options - Optional hooks and configuration
 * @returns A Hono app to mount at your desired path
 *
 * @example
 * ```ts
 * import { createAgentEndpoint } from "ag-ui-hono";
 * import { LangGraphAgent } from "ag-ui-langgraph";
 *
 * const agent = new LangGraphAgent({ name: "agent", graph });
 * const agentApp = createAgentEndpoint(
 *   (input, signal) => agent.clone().run(input),
 *   { onComplete: (threadId, msgs, events) => persist(threadId, msgs, events) }
 * );
 *
 * app.route("/api/agent", agentApp);
 * ```
 */
export function createAgentEndpoint(
  handler: AgentHandler,
  options: EndpointOptions = {},
): Hono {
  const app = new Hono();
  const log = options.logger;

  app.post("/", async (c) => {
    const startedAt = performance.now();
    let input: RunAgentInput;

    try {
      input = await c.req.json();
    } catch (error) {
      log?.warn("invalid agent request body", { error });
      return c.json({ error: "Invalid request body" }, 400);
    }

    const encoder = new EventEncoder({
      accept: c.req.header("Accept") || undefined,
    });

    // Allow input transformation (e.g. history hydration)
    const runInput = options.transformInput
      ? await options.transformInput(input)
      : input;

    log?.info("agent run accepted", {
      threadId: input.threadId,
      messageCount: input.messages.length,
    });

    const events: BaseEvent[] = [];

    return streamSSE(c, async (stream) => {
      const abortController = new AbortController();

      stream.onAbort(() => {
        abortController.abort();
        const durationMs =
          Math.round((performance.now() - startedAt) * 100) / 100;
        log?.warn("agent stream aborted", {
          threadId: input.threadId,
          eventCount: events.length,
          durationMs,
        });
        options.onAbort?.(input.threadId, events, runInput);
      });

      try {
        for await (const event of handler(runInput, abortController.signal)) {
          if (abortController.signal.aborted) break;
          events.push(event);
          await stream.write(encoder.encode(event));
        }

        if (!abortController.signal.aborted) {
          await options.onComplete?.(
            input.threadId,
            input.messages,
            events,
            runInput,
          );
          const durationMs =
            Math.round((performance.now() - startedAt) * 100) / 100;
          log?.info("agent run completed", {
            threadId: input.threadId,
            eventCount: events.length,
            durationMs,
          });
        }
      } catch (error) {
        const durationMs =
          Math.round((performance.now() - startedAt) * 100) / 100;
        log?.error("agent stream failed", {
          threadId: input.threadId,
          eventCount: events.length,
          durationMs,
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

        await options.onError?.(input.threadId, error, events, runInput);
      }
    });
  });

  // Health check (aligned with Python endpoint.py)
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  return app;
}
