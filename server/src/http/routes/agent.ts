/**
 * Agent HTTP route — refactored to use ag-ui-hono createAgentEndpoint.
 *
 * This thin wrapper shows how the demo app integrates the generic endpoint
 * with its own history hydration and persistence hooks.
 */

import { createAgentEndpoint } from "ag-ui-hono";

import { createLogger } from "../../config/logger.js";
import { runLangGraphAgent } from "../../services/agent/langgraph.js";
import { buildMessagesWithHistory } from "../../services/history/context.js";
import { persistHistory } from "../../services/history/persistence.js";

const logger = createLogger("agent");

export const agentRouter = createAgentEndpoint(
  (input, signal) => runLangGraphAgent(input, signal),
  {
    transformInput: (input) => ({
      ...input,
      messages: buildMessagesWithHistory(input.threadId, input.messages),
    }),
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
