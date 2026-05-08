import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import {
  LangGraphAgent,
  type LocalCompiledGraph,
} from "ag-ui-langgraph";

import { ProtocolDemoGraph } from "./graph.js";
import { createDemoVisualizationExtension } from "../visualization-extension.js";

const protocolAgent = new LangGraphAgent({
  name: "protocol-demo",
  graph: new ProtocolDemoGraph() as unknown as LocalCompiledGraph,
  eventExtensions: [createDemoVisualizationExtension()],
});

export async function* runProtocolDemoAgent(
  input: RunAgentInput,
): AsyncGenerator<BaseEvent> {
  yield* protocolAgent.clone().run(input);
}
