import { describe, expect, it } from "vitest";

import { researcherTools } from "./researcher.js";
import { writerTools } from "./writer.js";

function getToolNames(
  tools: Array<{
    name?: string;
  }>,
): string[] {
  return tools
    .map((tool) => tool.name)
    .filter((name): name is string => typeof name === "string");
}

describe("sub-agent tool boundaries", () => {
  it("does not allow the researcher to hand off directly to the writer", () => {
    expect(getToolNames(researcherTools)).not.toContain("transfer_to_writer");
  });

  it("does not allow the writer to hand off directly to the researcher", () => {
    expect(getToolNames(writerTools)).not.toContain("transfer_to_researcher");
  });
});
