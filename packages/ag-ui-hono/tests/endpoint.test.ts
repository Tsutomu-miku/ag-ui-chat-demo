/**
 * Tests for ag-ui-hono endpoint adapter.
 * Aligned with Python endpoint.py test coverage.
 */

import { EventType, type BaseEvent } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";

import { createAgentEndpoint } from "../src/endpoint.js";

// ── Helper: make a valid POST request body ──

function validBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    threadId: "t1",
    runId: "r1",
    messages: [{ id: "u1", role: "user", content: "hi" }],
    ...overrides,
  });
}

describe("createAgentEndpoint", () => {
  it("creates a Hono app instance", () => {
    const app = createAgentEndpoint(async function* () {
      yield { type: EventType.RUN_STARTED } as BaseEvent;
      yield { type: EventType.RUN_FINISHED } as BaseEvent;
    });

    expect(app).toBeDefined();
    expect(typeof app.fetch).toBe("function");
  });

  it("accepts custom options", () => {
    const onComplete = vi.fn();
    const onError = vi.fn();
    const onAbort = vi.fn();
    const transformInput = vi.fn((input) => input);

    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
      },
      {
        onComplete,
        onError,
        onAbort,
        transformInput,
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      },
    );

    expect(app).toBeDefined();
  });

  it("health endpoint returns ok", async () => {
    const app = createAgentEndpoint(async function* () {
      yield { type: EventType.RUN_STARTED } as BaseEvent;
    });

    const res = await app.request("/health", { method: "GET" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok" });
  });

  it("returns 400 for invalid request body", async () => {
    const app = createAgentEndpoint(async function* () {
      yield { type: EventType.RUN_STARTED } as BaseEvent;
    });

    const res = await app.request("/", {
      method: "POST",
      body: "invalid json{{{",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid request body");
  });

  it("streams events as SSE for valid request", async () => {
    const events: BaseEvent[] = [
      { type: EventType.RUN_STARTED, threadId: "t1", runId: "r1" } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hello",
      } as BaseEvent,
      {
        type: EventType.TEXT_MESSAGE_END,
        messageId: "m1",
      } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
    ];

    const app = createAgentEndpoint(async function* () {
      for (const event of events) {
        yield event;
      }
    });

    const res = await app.request("/", {
      method: "POST",
      body: validBody(),
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(200);
    // Consume the full stream body
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });

  it("calls transformInput when provided", async () => {
    const transformInput = vi.fn((input) => ({
      ...input,
      messages: [
        ...input.messages,
        { id: "injected", role: "system", content: "injected message" },
      ],
    }));

    let receivedInput: any = null;

    const app = createAgentEndpoint(
      async function* (input) {
        receivedInput = input;
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        yield { type: EventType.RUN_FINISHED } as BaseEvent;
      },
      { transformInput },
    );

    const res = await app.request("/", {
      method: "POST",
      body: validBody(),
      headers: { "Content-Type": "application/json" },
    });

    // Must consume the stream to trigger handler completion
    await res.text();

    expect(transformInput).toHaveBeenCalledOnce();
    expect(receivedInput?.messages).toHaveLength(2);
    expect(receivedInput?.messages[1].content).toBe("injected message");
  });

  it("calls onComplete after successful stream", async () => {
    const onComplete = vi.fn();

    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        yield { type: EventType.RUN_FINISHED } as BaseEvent;
      },
      { onComplete },
    );

    const res = await app.request("/", {
      method: "POST",
      body: validBody(),
      headers: { "Content-Type": "application/json" },
    });

    // Consuming the response body ensures the SSE stream handler runs to completion
    await res.text();
    // Allow async callbacks to settle
    await new Promise((r) => setTimeout(r, 100));

    expect(onComplete).toHaveBeenCalledWith(
      "t1",
      [{ id: "u1", role: "user", content: "hi" }],
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_STARTED }),
      ]),
    );
  });

  it("calls onError when handler throws", async () => {
    const onError = vi.fn();

    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        throw new Error("Test error");
      },
      { onError },
    );

    const res = await app.request("/", {
      method: "POST",
      body: validBody(),
      headers: { "Content-Type": "application/json" },
    });

    // Must consume the full response to trigger error path inside streamSSE
    await res.text();
    await new Promise((r) => setTimeout(r, 100));

    expect(onError).toHaveBeenCalledWith(
      "t1",
      expect.any(Error),
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_STARTED }),
      ]),
    );
  });
});
