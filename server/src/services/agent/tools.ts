import { ToolMessage, type BaseMessage } from "@langchain/core/messages";
import { tool, type ToolRunnableConfig } from "@langchain/core/tools";
import { Command, getCurrentTaskInput } from "@langchain/langgraph";
import { v4 as uuid } from "uuid";
import { z } from "zod";

const PRECEDENCE = new Map([
  ["+", 1],
  ["-", 1],
  ["*", 2],
  ["/", 2],
  ["%", 2],
]);

function applyOperator(left: number, right: number, operator: string): number {
  switch (operator) {
    case "+":
      return left + right;
    case "-":
      return left - right;
    case "*":
      return left * right;
    case "/":
      return left / right;
    case "%":
      return left % right;
    default:
      throw new Error(`Unsupported operator: ${operator}`);
  }
}

function tokenizeExpression(expression: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  let previous: string | undefined;

  while (index < expression.length) {
    const char = expression[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const isUnarySign =
      (char === "+" || char === "-") &&
      (!previous || PRECEDENCE.has(previous) || previous === "(") &&
      /[0-9.]/.test(expression[index + 1] || "");

    if (/[0-9.]/.test(char) || isUnarySign) {
      let value = char;
      index += 1;

      while (index < expression.length && /[0-9.]/.test(expression[index])) {
        value += expression[index];
        index += 1;
      }

      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error("Invalid number");

      tokens.push(String(parsed));
      previous = String(parsed);
      continue;
    }

    if (PRECEDENCE.has(char) || char === "(" || char === ")") {
      tokens.push(char);
      previous = char;
      index += 1;
      continue;
    }

    throw new Error("Invalid character");
  }

  return tokens;
}

function evaluateMathExpression(expression: string): number {
  const values: number[] = [];
  const operators: string[] = [];

  const reduce = () => {
    const operator = operators.pop();
    const right = values.pop();
    const left = values.pop();

    if (!operator || left === undefined || right === undefined) {
      throw new Error("Invalid expression");
    }

    values.push(applyOperator(left, right, operator));
  };

  for (const token of tokenizeExpression(expression)) {
    const numericValue = Number(token);

    if (Number.isFinite(numericValue)) {
      values.push(numericValue);
      continue;
    }

    if (token === "(") {
      operators.push(token);
      continue;
    }

    if (token === ")") {
      while (operators.length > 0 && operators[operators.length - 1] !== "(") {
        reduce();
      }

      if (operators.pop() !== "(") throw new Error("Mismatched parentheses");
      continue;
    }

    const tokenPrecedence = PRECEDENCE.get(token);
    if (!tokenPrecedence) throw new Error("Invalid operator");

    while (
      operators.length > 0 &&
      (PRECEDENCE.get(operators[operators.length - 1]) || 0) >= tokenPrecedence
    ) {
      reduce();
    }

    operators.push(token);
  }

  while (operators.length > 0) {
    if (operators[operators.length - 1] === "(") throw new Error("Mismatched parentheses");
    reduce();
  }

  if (values.length !== 1) throw new Error("Invalid expression");

  return values[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentTaskMessages(): BaseMessage[] {
  const state = getCurrentTaskInput();
  if (!isRecord(state) || !Array.isArray(state.messages)) return [];
  return state.messages as BaseMessage[];
}

function createTransferTool(targetAgent: "researcher" | "writer") {
  const name = `transfer_to_${targetAgent}`;

  return tool(
    async (
      _input: {
        input: string;
      },
      config?: ToolRunnableConfig,
    ) => {
      const toolMessage = new ToolMessage({
        content: `Successfully transferred to ${targetAgent}`,
        name,
        tool_call_id: config?.toolCall?.id ?? uuid(),
      });

      return new Command({
        goto: targetAgent,
        graph: Command.PARENT,
        update: {
          messages: [...currentTaskMessages(), toolMessage],
        },
      });
    },
    {
      name,
      description: `Transfer control to the ${targetAgent} agent.`,
      schema: z.object({
        input: z
          .string()
          .describe(
            `The exact task or instructions that the ${targetAgent} should complete.`,
          ),
      }),
    },
  );
}

export const getWeather = tool(
  async ({ city }: { city: string }) => {
    const conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy", "Windy"];
    const temp = Math.floor(Math.random() * 35) + 5;
    const condition = conditions[Math.floor(Math.random() * conditions.length)];

    return JSON.stringify({
      city,
      temperature: `${temp} C`,
      condition,
      humidity: `${Math.floor(Math.random() * 60) + 30}%`,
      wind: `${Math.floor(Math.random() * 30) + 5} km/h`,
    });
  },
  {
    name: "get_weather",
    description:
      "Get the current weather for a specified city. Returns temperature, condition, humidity and wind speed.",
    schema: z.object({
      city: z.string().describe("The city name, e.g. 'Tokyo', 'New York'"),
    }),
  }
);

export const searchWeb = tool(
  async ({ query }: { query: string }) => {
    return JSON.stringify({
      query,
      results: [
        {
          title: `Top result for "${query}"`,
          url: "https://example.com/1",
          snippet: `Comprehensive information about ${query}...`,
        },
        {
          title: `${query} - Wikipedia`,
          url: "https://example.com/2",
          snippet: `${query} refers to a widely discussed topic...`,
        },
        {
          title: `Latest news on ${query}`,
          url: "https://example.com/3",
          snippet: `Recent developments regarding ${query}...`,
        },
      ],
    });
  },
  {
    name: "search_web",
    description:
      "Search the web for information on any topic. Returns a list of relevant results with titles, URLs and snippets.",
    schema: z.object({ query: z.string().describe("The search query") }),
  }
);

export const calculate = tool(
  async ({ expression }: { expression: string }) => {
    try {
      const result = evaluateMathExpression(expression);

      return JSON.stringify({ expression, result });
    } catch {
      return JSON.stringify({ expression, error: "Invalid mathematical expression" });
    }
  },
  {
    name: "calculate",
    description: "Evaluate a mathematical expression. Supports +, -, *, /, (), and %.",
    schema: z.object({
      expression: z.string().describe("Math expression, e.g. '(2 + 3) * 4'"),
    }),
  }
);

export const composeText = tool(
  async ({
    content,
    instructions,
  }: {
    content: string;
    instructions?: string;
  }) => {
    const normalized = content.trim().replace(/\s+/g, " ");
    const wantsShortSentence =
      instructions?.toLowerCase().includes("short sentence") ?? false;

    return JSON.stringify({
      content,
      instructions: instructions ?? null,
      draft: wantsShortSentence
        ? normalized.replace(/[.!?]*$/, ".")
        : normalized,
    });
  },
  {
    name: "compose_text",
    description:
      "Compose or polish text from source content and writing instructions.",
    schema: z.object({
      content: z.string().describe("Source content to rewrite or summarize"),
      instructions: z
        .string()
        .optional()
        .describe("Writing instructions, tone, or format requirements"),
    }),
  }
);

export const summarizeText = tool(
  async ({
    text,
    sentenceCount,
  }: {
    text: string;
    sentenceCount?: number;
  }) => {
    const normalized = text.trim().replace(/\s+/g, " ");
    const sentences = normalized
      .split(/(?<=[.!?])\s+/)
      .filter(Boolean)
      .slice(0, Math.max(1, sentenceCount ?? 1));

    return JSON.stringify({
      text,
      sentenceCount: sentenceCount ?? 1,
      summary: (sentences[0] ?? normalized).replace(/[.!?]*$/, "."),
    });
  },
  {
    name: "summarize_text",
    description: "Summarize source text into one or more short sentences.",
    schema: z.object({
      text: z.string().describe("Source text to summarize"),
      sentenceCount: z
        .number()
        .optional()
        .describe("Desired number of sentences"),
    }),
  }
);

export const writeText = tool(
  async ({
    content,
    format,
  }: {
    content: string;
    format?: string;
  }) => {
    const draft = content.trim().replace(/\s+/g, " ");
    return JSON.stringify({
      content,
      format: format ?? "plain",
      draft,
    });
  },
  {
    name: "write_text",
    description: "Write or reformat content into the requested format.",
    schema: z.object({
      content: z.string().describe("Source content to write from"),
      format: z.string().optional().describe("Requested output format"),
    }),
  }
);

export const getCurrentTime = tool(
  async () => {
    const now = new Date();

    return JSON.stringify({
      iso: now.toISOString(),
      formatted: now.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long",
      }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      unix: Math.floor(now.getTime() / 1000),
    });
  },
  {
    name: "get_current_time",
    description: "Get the current date, time, and timezone information.",
    schema: z.object({}),
  }
);

export const confirmAction = tool(
  async ({ action, details }: { action: string; details?: string }) => {
    return JSON.stringify({
      status: "pending_frontend_confirmation",
      action,
      details: details ?? null,
    });
  },
  {
    name: "confirm_action",
    description:
      "Ask the user to confirm an important action in the frontend before continuing.",
    schema: z.object({
      action: z.string().describe("The action that requires confirmation"),
      details: z
        .string()
        .optional()
        .describe("Optional context shown to the user"),
    }),
  }
);

export const collectUserInput = tool(
  async ({
    prompt,
    fieldName,
  }: {
    prompt: string;
    fieldName?: string;
  }) => {
    return JSON.stringify({
      status: "pending_frontend_input",
      prompt,
      fieldName: fieldName ?? "response",
    });
  },
  {
    name: "collect_user_input",
    description:
      "Ask the frontend to collect a short piece of user input before continuing.",
    schema: z.object({
      prompt: z.string().describe("The question or prompt shown to the user"),
      fieldName: z
        .string()
        .optional()
        .describe("Optional field name for the collected answer"),
    }),
  }
);

export const backendTools = [
  getWeather,
  searchWeb,
  calculate,
  composeText,
  summarizeText,
  writeText,
  getCurrentTime,
];
export const frontendInteractionTools = [confirmAction, collectUserInput];
export const transferToResearcher = createTransferTool("researcher");
export const transferToWriter = createTransferTool("writer");
