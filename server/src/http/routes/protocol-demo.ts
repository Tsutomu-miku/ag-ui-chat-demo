/**
 * Deterministic protocol showcase route.
 *
 * This endpoint exercises ag-ui-langgraph without requiring an LLM key.
 */

import { createAgentEndpoint } from "ag-ui-hono";

import { createLogger } from "../../config/logger.js";
import { runProtocolDemoAgent } from "../../services/agent/protocol-demo/index.js";
import { persistHistory } from "../../services/history/persistence.js";

const logger = createLogger("protocol-demo");

export const protocolDemoRouter = createAgentEndpoint(
  (input) => runProtocolDemoAgent(input),
  {
    onComplete: (threadId, inputMessages, events) => {
      persistHistory(threadId, inputMessages, events);
    },
    logger: {
      info: (msg, meta) => logger.info(msg, meta),
      warn: (msg, meta) => logger.warn(msg, meta),
      error: (msg, meta) => logger.error(msg, meta),
    },
  },
);
