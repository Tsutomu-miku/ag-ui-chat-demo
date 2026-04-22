import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const getWeather = tool(
  async ({ city }: { city: string }) => {
    const conditions = ["Sunny", "Cloudy", "Rainy", "Snowy", "Windy"];
    const temp = Math.floor(Math.random() * 35) + 5;
    const condition =
      conditions[Math.floor(Math.random() * conditions.length)];
    return JSON.stringify({
      city,
      temperature: `${temp}°C`,
      condition,
      humidity: `${Math.floor(Math.random() * 60) + 30}%`,
    });
  },
  {
    name: "get_weather",
    description: "Get the current weather for a city",
    schema: z.object({
      city: z.string().describe("The city name"),
    }),
  }
);

const searchWeb = tool(
  async ({ query }: { query: string }) => {
    return JSON.stringify({
      query,
      results: [
        {
          title: `Result 1 for "${query}"`,
          snippet:
            "This is a mock search result with relevant information about the topic.",
        },
        {
          title: `Result 2 for "${query}"`,
          snippet:
            "Another relevant result containing useful details and context.",
        },
        {
          title: `Result 3 for "${query}"`,
          snippet:
            "More information about this topic from a different source.",
        },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

const calculate = tool(
  async ({ expression }: { expression: string }) => {
    try {
      // Safe math evaluation — only allow numbers and basic operators
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return JSON.stringify({ expression, result: String(result) });
    } catch {
      return JSON.stringify({ expression, error: "Invalid expression" });
    }
  },
  {
    name: "calculate",
    description: "Calculate a mathematical expression",
    schema: z.object({
      expression: z
        .string()
        .describe("The math expression to evaluate, e.g. '2 + 3 * 4'"),
    }),
  }
);

const getCurrentTime = tool(
  async () => {
    const now = new Date();
    return JSON.stringify({
      datetime: now.toISOString(),
      formatted: now.toLocaleString("en-US", {
        dateStyle: "full",
        timeStyle: "long",
      }),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
  },
  {
    name: "get_current_time",
    description: "Get the current date and time",
    schema: z.object({}),
  }
);

export function createAgent() {
  const model = new ChatOpenAI({
    modelName: "gpt-4o-mini",
    temperature: 0.7,
    streaming: true,
  });

  return createReactAgent({
    llm: model,
    tools: [getWeather, searchWeb, calculate, getCurrentTime],
  });
}
