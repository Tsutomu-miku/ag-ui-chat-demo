import { inspect } from "node:util";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const LEVEL_VALUES: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const CURRENT_FILE = fileURLToPath(import.meta.url);
const WORKSPACE_DIR = resolve(dirname(CURRENT_FILE), "../../..");
const STACK_LINE_PATTERN =
  /\(?((?:file:\/\/)?(?:\/|[A-Za-z]:\\)[^()]+?\.(?:ts|tsx|js|mjs|cjs)):(\d+):(\d+)\)?$/;

interface ParsedStackLine {
  filePath: string;
  line: string;
  column: string;
}

export interface Logger {
  debug: (message: string, fields?: LogFields) => void;
  info: (message: string, fields?: LogFields) => void;
  warn: (message: string, fields?: LogFields) => void;
  error: (message: string, fields?: LogFields) => void;
}

function getConfiguredLevel(): LogLevel {
  const rawLevel = (process.env.LOG_LEVEL || process.env.BACKEND_LOG_LEVEL || "info").toLowerCase();

  if (rawLevel in LEVEL_VALUES) {
    return rawLevel as LogLevel;
  }

  return "info";
}

function getConfiguredFormat() {
  return process.env.LOG_FORMAT === "json" ? "json" : "pretty";
}

function shouldLog(level: LogLevel) {
  return LEVEL_VALUES[level] >= LEVEL_VALUES[getConfiguredLevel()];
}

function parseStackLine(line: string): ParsedStackLine | undefined {
  const match = STACK_LINE_PATTERN.exec(line.trim());

  if (!match) {
    return undefined;
  }

  const [, rawPath, stackLine, column] = match;
  const filePath = rawPath.startsWith("file://") ? fileURLToPath(rawPath) : rawPath;

  return { filePath, line: stackLine, column };
}

function getCallsite(): string | undefined {
  const stack = new Error().stack?.split("\n").slice(1) || [];

  for (const line of stack) {
    const parsed = parseStackLine(line);

    if (!parsed || parsed.filePath === CURRENT_FILE) {
      continue;
    }

    return `${relative(WORKSPACE_DIR, parsed.filePath)}:${parsed.line}:${parsed.column}`;
  }

  return undefined;
}

function normalizeError(error: Error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
}

function toJsonValue(value: unknown): unknown {
  if (value instanceof Error) {
    return normalizeError(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

function createJsonReplacer() {
  const seen = new WeakSet<object>();

  return (_key: string, value: unknown) => {
    const jsonValue = toJsonValue(value);

    if (typeof jsonValue === "object" && jsonValue !== null) {
      if (seen.has(jsonValue)) {
        return "[Circular]";
      }

      seen.add(jsonValue);
    }

    return jsonValue;
  };
}

function stringifyJson(payload: Record<string, unknown>) {
  return JSON.stringify(payload, createJsonReplacer());
}

function formatValue(value: unknown) {
  if (value instanceof Error) {
    return inspect(normalizeError(value), {
      breakLength: Number.POSITIVE_INFINITY,
      colors: false,
      compact: true,
      depth: 3,
    });
  }

  if (typeof value === "string") {
    return value.includes(" ") ? JSON.stringify(value) : value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  return inspect(value, {
    breakLength: Number.POSITIVE_INFINITY,
    colors: false,
    compact: true,
    depth: 5,
  });
}

function formatPretty(payload: Record<string, unknown>) {
  const timestamp = String(payload.timestamp);
  const level = String(payload.level).toUpperCase().padEnd(5);
  const scope = payload.scope ? ` [${String(payload.scope)}]` : "";
  const message = String(payload.message);
  const source = payload.source ? ` ${String(payload.source)}` : "";
  const fields = Object.entries(payload)
    .filter(([key, value]) => {
      return (
        !["timestamp", "level", "scope", "message", "source"].includes(key) &&
        value !== undefined
      );
    })
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");

  return `${timestamp} ${level}${scope} ${message}${source}${fields ? ` ${fields}` : ""}`;
}

function writeLog(level: LogLevel, scope: string, message: string, fields: LogFields = {}) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    source: getCallsite(),
    ...fields,
  };
  const line = getConfiguredFormat() === "json" ? stringifyJson(payload) : formatPretty(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  if (level === "debug") {
    console.debug(line);
    return;
  }

  console.info(line);
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message, fields) => writeLog("debug", scope, message, fields),
    info: (message, fields) => writeLog("info", scope, message, fields),
    warn: (message, fields) => writeLog("warn", scope, message, fields),
    error: (message, fields) => writeLog("error", scope, message, fields),
  };
}

export function getLoggerConfig() {
  return {
    level: getConfiguredLevel(),
    format: getConfiguredFormat(),
  };
}
