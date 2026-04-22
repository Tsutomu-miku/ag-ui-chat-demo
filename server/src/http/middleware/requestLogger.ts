import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

import { createLogger } from "../../config/logger.js";

const logger = createLogger("http");

function durationSince(startedAt: number) {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function getClientIp(headers: Headers) {
  return (
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    headers.get("x-real-ip") ||
    undefined
  );
}

export const requestLogger: MiddlewareHandler = async (c, next) => {
  const startedAt = performance.now();
  const requestId = c.req.header("x-request-id") || randomUUID();
  const fields = {
    requestId,
    method: c.req.method,
    path: c.req.path,
    ip: getClientIp(c.req.raw.headers),
  };

  c.header("x-request-id", requestId);
  logger.debug("request started", fields);

  try {
    await next();
  } catch (error) {
    logger.error("request failed", {
      ...fields,
      durationMs: durationSince(startedAt),
      error,
    });
    throw error;
  }

  const status = c.res.status;
  const completedFields = {
    ...fields,
    status,
    durationMs: durationSince(startedAt),
  };

  if (status >= 500) {
    logger.error("request completed", completedFields);
    return;
  }

  if (status >= 400) {
    logger.warn("request completed", completedFields);
    return;
  }

  logger.info("request completed", completedFields);
};
