import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import {
  LangGraphAgent,
  type LocalCompiledGraph,
} from "ag-ui-langgraph";

import { ProtocolDemoGraph } from "./graph.js";

const protocolAgent = new LangGraphAgent({
  name: "protocol-demo",
  graph: new ProtocolDemoGraph() as unknown as LocalCompiledGraph,
  subAgents: ["researcher", "writer"],
});

export async function* runProtocolDemoAgent(
  input: RunAgentInput,
): AsyncGenerator<BaseEvent> {
  yield* protocolAgent.clone().run(input);
}
