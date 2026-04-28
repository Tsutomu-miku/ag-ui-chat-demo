import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { LangGraphAgent } from "ag-ui-langgraph";

import { ProtocolDemoGraph } from "./graph.js";

const protocolAgent = new LangGraphAgent({
  name: "protocol-demo",
  graph: new ProtocolDemoGraph() as any,
});

export async function* runProtocolDemoAgent(
  input: RunAgentInput,
): AsyncGenerator<BaseEvent> {
  yield* protocolAgent.clone().run(input);
}
