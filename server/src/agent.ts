import { ChatOpenAI } from "@langchain/openai";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { tool } from "@langchain/core/tools";
import { z } from "zod";

// ============================================================
// Backend Tools - These execute on the server inside the agent
// ============================================================

const getWeather = tool(
  async ({ city }: { city: string }) => {
    const conditions = ["Sunny", "Cloudy", "Rainy", "Partly Cloudy", "Windy"];
    const temp = Math.floor(Math.random() * 35) + 5;
    const condition = conditions[Math.floor(Math.random() * conditions.length)];
    return JSON.stringify({
      city,
      temperature: `${temp}°C`,
      condition,
      humidity: `${Math.floor(Math.random() * 60) + 30}%`,
      wind: `${Math.floor(Math.random() * 30) + 5} km/h`,
    });
  },
  {
    name: "get_weather",
    description: "Get the current weather for a specified city. Returns temperature, condition, humidity and wind speed.",
    schema: z.object({ city: z.string().describe("The city name, e.g. 'Tokyo', 'New York'") }),
  }
);

const searchWeb = tool(
  async ({ query }: { query: string }) => {
    return JSON.stringify({
      query,
      results: [
        { title: `Top result for "${query}"`, url: "https://example.com/1", snippet: `Comprehensive information about ${query}...` },
        { title: `${query} - Wikipedia`, url: "https://example.com/2", snippet: `${query} refers to a widely discussed topic...` },
        { title: `Latest news on ${query}`, url: "https://example.com/3", snippet: `Recent developments regarding ${query}...` },
      ],
    });
  },
  {
    name: "search_web",
    description: "Search the web for information on any topic. Returns a list of relevant results with titles, URLs and snippets.",
    schema: z.object({ query: z.string().describe("The search query") }),
  }
);

const calculate = tool(
  async ({ expression }: { expression: string }) => {
    try {
      const sanitized = expression.replace(/[^0-9+\-*/().%\s]/g, "");
      const result = Function(`"use strict"; return (${sanitized})`)();
      return JSON.stringify({ expression, result: Number(result) });
    } catch {
      return JSON.stringify({ expression, error: "Invalid mathematical expression" });
    }
  },
  {
    name: "calculate",
    description: "Evaluate a mathematical expression. Supports +, -, *, /, (), and %.",
    schema: z.object({ expression: z.string().describe("Math expression, e.g. '(2 + 3) * 4'") }),
  }
);

const getCurrentTime = tool(
  async () => {
    const now = new Date();
    return JSON.stringify({
      iso: now.toISOString(),
      formatted: now.toLocaleString("en-US", { dateStyle: "full", timeStyle: "long" }),
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

/**
 * Creates a LangGraph ReAct agent with backend tools.
 * 
 * The agent uses a ReAct loop: Model -> Tool Call -> Tool Result -> Model -> ...
 * Backend tools (defined here) are executed server-side automatically by LangGraph.
 * Frontend tools (passed via RunAgentInput.tools) are converted by @ag-ui/langchain
 * and emitted as TOOL_CALL events for the client to handle.
 */
export function createAgentModel() {
  return new ChatOpenAI({
    modelName: "gpt-4o-mini",
    temperature: 0.7,
    streaming: true,
  });
}

export const backendTools = [getWeather, searchWeb, calculate, getCurrentTime];

export function createLangGraphAgent() {
  const model = createAgentModel();
  return createReactAgent({
    llm: model,
    tools: backendTools,
  });
}
