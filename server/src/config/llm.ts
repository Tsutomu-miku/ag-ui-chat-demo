export type LlmProvider = "openai" | "openrouter";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  model: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  streamUsage: boolean;
}

const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const DEFAULT_OPENROUTER_MODEL = "openai/gpt-4o-mini";
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function readProvider(): LlmProvider {
  const provider = process.env.LLM_PROVIDER?.toLowerCase();

  if (!provider) {
    return process.env.OPENROUTER_API_KEY ? "openrouter" : "openai";
  }

  if (provider === "openai" || provider === "openrouter") {
    return provider;
  }

  throw new Error(`Unsupported LLM_PROVIDER "${process.env.LLM_PROVIDER}"`);
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required for the selected LLM provider`);
  }

  return value;
}

function getOpenRouterHeaders(): Record<string, string> | undefined {
  const headers: Record<string, string> = {};
  const siteUrl = process.env.OPENROUTER_SITE_URL;
  const appName = process.env.OPENROUTER_APP_NAME;

  if (siteUrl) headers["HTTP-Referer"] = siteUrl;
  if (appName) headers["X-Title"] = appName;

  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function getLlmConfig(): LlmConfig {
  const provider = readProvider();

  if (provider === "openrouter") {
    return {
      provider,
      apiKey: requireEnv("OPENROUTER_API_KEY"),
      model: process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      baseURL: process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL,
      defaultHeaders: getOpenRouterHeaders(),
      streamUsage: false,
    };
  }

  return {
    provider,
    apiKey: requireEnv("OPENAI_API_KEY"),
    model: process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL,
    baseURL: process.env.OPENAI_BASE_URL,
    streamUsage: true,
  };
}
