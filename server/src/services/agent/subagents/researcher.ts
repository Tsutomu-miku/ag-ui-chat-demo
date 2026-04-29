import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  searchWeb,
  getWeather,
  getCurrentTime,
} from "../tools.js";

/**
 * Tools available to the Researcher sub-agent.
 * The researcher can search the web, check weather data, and get the current time.
 */
export const researcherTools: StructuredToolInterface[] = [
  searchWeb,
  getWeather,
  getCurrentTime,
];

export const RESEARCHER_SYSTEM_PROMPT = `You are a Research Specialist. Your job is to gather information using the tools available to you.

Instructions:
- Use the search_web tool to find relevant information
- Use get_weather for weather-related queries
- Use get_current_time when time information is needed
- Synthesize your findings into a clear, factual summary
- Always cite which tool/source provided each piece of information
- Be thorough but concise
- Prefer returning research findings to the supervisor when the research task is done
- Do NOT transfer to another agent; return the research findings to the supervisor for routing
- Return factual findings directly, not a meta-summary about what you did unless the user explicitly asks for it`;
