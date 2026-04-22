import { ChatOpenAI } from "@langchain/openai";

import { createLogger } from "../../config/logger.js";
import { getLlmConfig } from "../../config/llm.js";

const logger = createLogger("llm");

export function createAgentModel() {
  const config = getLlmConfig();

  logger.debug("creating chat model", {
    provider: config.provider,
    model: config.model,
    baseURL: config.baseURL,
    streamUsage: config.streamUsage,
    defaultHeaderNames: Object.keys(config.defaultHeaders || {}),
  });

  return new ChatOpenAI({
    apiKey: config.apiKey,
    model: config.model,
    temperature: 0.7,
    streaming: true,
    streamUsage: config.streamUsage,
    configuration: {
      baseURL: config.baseURL,
      defaultHeaders: config.defaultHeaders,
    },
  });
}
