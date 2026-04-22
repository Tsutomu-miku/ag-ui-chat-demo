import { Hono } from "hono";
import { cors } from "hono/cors";

import { createLogger } from "./config/logger.js";
import { requestLogger } from "./http/middleware/requestLogger.js";
import { agentRouter } from "./http/routes/agent.js";
import { healthRouter } from "./http/routes/health.js";
import { historyRouter } from "./http/routes/history.js";

const logger = createLogger("app");

export function createApp() {
  const app = new Hono();

  app.use("/*", requestLogger);

  app.use(
    "/*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowHeaders: ["*"],
    })
  );

  app.route("/api/agent", agentRouter);
  app.route("/api/health", healthRouter);
  app.route("/api/history", historyRouter);

  app.notFound((c) => {
    logger.warn("route not found", {
      method: c.req.method,
      path: c.req.path,
    });

    return c.json({ error: "Not found" }, 404);
  });

  app.onError((error, c) => {
    logger.error("unhandled request error", {
      method: c.req.method,
      path: c.req.path,
      error,
    });

    return c.json({ error: "Internal server error" }, 500);
  });

  return app;
}
