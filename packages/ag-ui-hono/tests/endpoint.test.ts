import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { describe, expect, it, vi } from "vitest";

import { createAgentEndpoint } from "../src/endpoint.js";

const inputMessages: RunAgentInput["messages"] = [
  { id: "u1", role: "user", content: "hi" },
];

function validInput(overrides: Partial<RunAgentInput> = {}): RunAgentInput {
  return {
    threadId: "t1",
    runId: "r1",
    messages: inputMessages,
    tools: [],
    context: [],
    forwardedProps: {},
    ...overrides,
  };
}

function validBody(overrides: Partial<RunAgentInput> = {}) {
  return JSON.stringify(validInput(overrides));
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const dataLine = block
        .split("\n")
        .find((line) => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      return JSON.parse(dataLine!.slice("data: ".length)) as Record<
        string,
        unknown
      >;
    });
}

async function postAgent(app: ReturnType<typeof createAgentEndpoint>) {
  return app.request("/", {
    method: "POST",
    body: validBody(),
    headers: { "Content-Type": "application/json" },
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

  it("health endpoint returns ok", async () => {
    const app = createAgentEndpoint(async function* () {
      yield { type: EventType.RUN_STARTED } as BaseEvent;
    });

    const res = await app.request("/health", { method: "GET" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns 400 and logs for invalid request body", async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
      },
      { logger },
    );

    const res = await app.request("/", {
      method: "POST",
      body: "invalid json{{{",
      headers: { "Content-Type": "application/json" },
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid request body" });
    expect(logger.warn).toHaveBeenCalledWith(
      "invalid agent request body",
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("streams encoded SSE events for valid requests", async () => {
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
      { type: EventType.TEXT_MESSAGE_END, messageId: "m1" } as BaseEvent,
      { type: EventType.RUN_FINISHED, threadId: "t1", runId: "r1" } as BaseEvent,
    ];

    const app = createAgentEndpoint(async function* () {
      for (const event of events) {
        yield event;
      }
    });

    const res = await postAgent(app);
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(parseSseEvents(text)).toEqual([
      expect.objectContaining({ type: EventType.RUN_STARTED }),
      expect.objectContaining({ type: EventType.TEXT_MESSAGE_START }),
      expect.objectContaining({
        type: EventType.TEXT_MESSAGE_CONTENT,
        delta: "Hello",
      }),
      expect.objectContaining({ type: EventType.TEXT_MESSAGE_END }),
      expect.objectContaining({ type: EventType.RUN_FINISHED }),
    ]);
  });

  it("passes transformed input to the handler", async () => {
    const transformedMessages: RunAgentInput["messages"] = [
      ...inputMessages,
      { id: "system-1", role: "system", content: "injected message" },
    ];
    const transformInput = vi.fn(async (input: RunAgentInput) => ({
      ...input,
      messages: transformedMessages,
      state: { hydrated: true },
    }));
    let receivedInput: RunAgentInput | undefined;

    const app = createAgentEndpoint(
      async function* (input) {
        receivedInput = input;
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        yield { type: EventType.RUN_FINISHED } as BaseEvent;
      },
      { transformInput },
    );

    const res = await postAgent(app);
    await res.text();

    expect(transformInput).toHaveBeenCalledWith(validInput());
    expect(receivedInput?.messages).toEqual(transformedMessages);
    expect(receivedInput?.state).toEqual({ hydrated: true });
  });

  it("calls onComplete with original messages and transformed run input", async () => {
    const onComplete = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const transformedInput = validInput({
      messages: [
        ...inputMessages,
        { id: "system-1", role: "system", content: "history" },
      ],
    });

    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        yield { type: EventType.RUN_FINISHED } as BaseEvent;
      },
      {
        transformInput: () => transformedInput,
        onComplete,
        logger,
      },
    );

    const res = await postAgent(app);
    await res.text();

    expect(onComplete).toHaveBeenCalledWith(
      "t1",
      inputMessages,
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_STARTED }),
        expect.objectContaining({ type: EventType.RUN_FINISHED }),
      ]),
      transformedInput,
    );
    expect(logger.info).toHaveBeenCalledWith(
      "agent run accepted",
      expect.objectContaining({ threadId: "t1", messageCount: 1 }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "agent run completed",
      expect.objectContaining({ threadId: "t1", eventCount: 2 }),
    );
  });

  it("streams RUN_ERROR and calls onError when handler throws", async () => {
    const onError = vi.fn();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const app = createAgentEndpoint(
      async function* () {
        yield { type: EventType.RUN_STARTED } as BaseEvent;
        throw new Error("Test error");
      },
      { onError, logger },
    );

    const res = await postAgent(app);
    const text = await res.text();
    const events = parseSseEvents(text);

    expect(events).toEqual([
      expect.objectContaining({ type: EventType.RUN_STARTED }),
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: "Test error",
      }),
    ]);
    expect(onError).toHaveBeenCalledWith(
      "t1",
      expect.any(Error),
      expect.arrayContaining([
        expect.objectContaining({ type: EventType.RUN_STARTED }),
        expect.objectContaining({ type: EventType.RUN_ERROR }),
      ]),
      validInput(),
    );
    expect(logger.error).toHaveBeenCalledWith(
      "agent stream failed",
      expect.objectContaining({ threadId: "t1", eventCount: 1 }),
    );
  });

  it("does not duplicate an existing RUN_ERROR event when handler throws", async () => {
    const onError = vi.fn();
    const app = createAgentEndpoint(
      async function* () {
        yield {
          type: EventType.RUN_ERROR,
          message: "Agent emitted error",
        } as BaseEvent;
        throw new Error("Handler cleanup failed");
      },
      { onError },
    );

    const res = await postAgent(app);
    const events = parseSseEvents(await res.text());

    expect(events).toEqual([
      expect.objectContaining({
        type: EventType.RUN_ERROR,
        message: "Agent emitted error",
      }),
    ]);
    expect(onError).toHaveBeenCalledWith(
      "t1",
      expect.any(Error),
      [expect.objectContaining({ type: EventType.RUN_ERROR })],
      validInput(),
    );
  });
});
