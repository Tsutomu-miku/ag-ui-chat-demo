import type { FrontendToolDefinition } from "ag-ui-react";

export const FRONTEND_TOOLS: FrontendToolDefinition[] = [
  {
    name: "confirm_action",
    description:
      "Ask the user to confirm or reject a proposed action before proceeding. Use this when you are about to perform something important or irreversible.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Description of the action to confirm",
        },
        severity: {
          type: "string",
          enum: ["low", "medium", "high"],
          description: "How critical this action is",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "collect_user_input",
    description:
      "Ask the user to provide additional information via a text input. Use when you need more details to complete a task.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The question or prompt to show the user",
        },
        placeholder: {
          type: "string",
          description: "Placeholder text for the input field",
        },
      },
      required: ["prompt"],
    },
  },
];
