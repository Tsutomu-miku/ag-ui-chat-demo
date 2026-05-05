export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(
  value: unknown,
  key: string,
): unknown | undefined {
  if (!isRecord(value)) return undefined;
  return value[key];
}

export function stringValue(
  value: unknown,
  key: string,
): string | undefined {
  const item = recordValue(value, key);
  return typeof item === "string" ? item : undefined;
}

export function arrayValue(value: unknown, key: string): unknown[] {
  const item = recordValue(value, key);
  return Array.isArray(item) ? item : [];
}
