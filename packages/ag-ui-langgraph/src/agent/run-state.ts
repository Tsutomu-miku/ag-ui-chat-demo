import type { RunMetadata } from "../types.js";

export function createRunMetadata(opts: {
  runId: string;
  threadId: string;
}): RunMetadata {
  return {
    id: opts.runId,
    thread_id: opts.threadId,
    mode: "start",
    node_name: null,
    prev_node_name: null,
    has_function_streaming: false,
    streamed_tool_call_ids: new Set<string>(),
    model_made_tool_call: false,
    state_reliable: true,
    reasoning_process: null,
    manually_emitted_state: null,
    wait_for_frontend_tool: false,
  };
}
