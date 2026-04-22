import { Hono } from "hono";

import {
  deleteThread,
  getThread,
  listThreads,
} from "../../services/history/store.js";

export const historyRouter = new Hono();

historyRouter.get("/threads", (c) => {
  return c.json(listThreads());
});

historyRouter.get("/threads/:id", (c) => {
  const thread = getThread(c.req.param("id"));

  if (!thread) {
    return c.json({ error: "Thread not found" }, 404);
  }

  return c.json(thread);
});

historyRouter.delete("/threads/:id", (c) => {
  const ok = deleteThread(c.req.param("id"));

  if (!ok) {
    return c.json({ error: "Thread not found" }, 404);
  }

  return c.json({ success: true });
});
