import "./config/env.js";

import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { createLogger, getLoggerConfig } from "./config/logger.js";

const port = Number(process.env.PORT || 4000);
const app = createApp();
const logger = createLogger("server");

serve({ fetch: app.fetch, port }, (info) => {
  logger.info("server started", {
    port: info.port,
    url: `http://localhost:${info.port}`,
    agentEndpoint: `POST http://localhost:${info.port}/api/agent`,
    historyEndpoint: `GET http://localhost:${info.port}/api/history/threads`,
    healthEndpoint: `GET http://localhost:${info.port}/api/health`,
    logger: getLoggerConfig(),
  });
});
