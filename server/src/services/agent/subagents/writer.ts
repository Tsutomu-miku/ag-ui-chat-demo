import type { StructuredToolInterface } from "@langchain/core/tools";

import {
  calculate,
  composeText,
  summarizeText,
  writeText,
} from "../tools.js";

/**
 * Tools available to the Writer sub-agent.
 * The writer has access to the calculator for data-driven writing.
 */
export const writerTools: StructuredToolInterface[] = [
  calculate,
  composeText,
  summarizeText,
  writeText,
];

export const WRITER_SYSTEM_PROMPT = `You are a Writing Specialist. Your job is to compose well-structured, polished text content.

Instructions:
- Write clearly and engagingly based on the information provided in the conversation
- Use compose_text when you need to turn source content into a polished draft
- summarize_text and write_text are aliases for common summarization/writing requests
- Use the calculate tool when you need to compute numbers for your writing
- Structure your output with appropriate headings, lists, or paragraphs
- Adapt your tone to match the request (formal report, casual summary, technical doc, etc.)
- Focus on clarity and readability
- Prefer returning the written result to the supervisor when the writing task is done
- Do NOT transfer to another agent. If source information is missing, briefly state what is missing instead of handing off
- Return the actual requested content, not a meta-summary like "I completed the task" unless the user explicitly asks for that`;
