/**
 * This file is kept as a thin re-export for backward compatibility.
 * The canonical implementation now lives in the `ag-ui-langchain` package.
 */

export {
  contentToString,
  parseToolArgs,
  toLangChainMessages,
  frontendToolToModelTool,
  getToolCalls,
  asArray,
} from "ag-ui-langchain";

export type { LangChainToolCall } from "ag-ui-langchain";
