import { describe, expect, it } from "vitest";

import { createAgentEndpoint } from "../../src/index.js";

describe("public exports", () => {
  it("exports createAgentEndpoint from the root entrypoint", () => {
    expect(createAgentEndpoint).toBeTypeOf("function");
  });

  it("creates a Hono-compatible app through the root entrypoint", () => {
    const app = createAgentEndpoint(async function* () {});

    expect(app).toBeDefined();
    expect(typeof app.fetch).toBe("function");
  });
});
