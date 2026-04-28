import type { SchemaKeys } from "../types.js";

function schemaKeysFrom(schema: unknown): string[] {
  const maybeSchema =
    typeof schema === "function" ? (schema as () => unknown)() : schema;
  const resolved =
    maybeSchema &&
    typeof maybeSchema === "object" &&
    "schema" in maybeSchema &&
    typeof (maybeSchema as { schema: unknown }).schema === "function"
      ? (maybeSchema as { schema: () => unknown }).schema()
      : maybeSchema &&
          typeof maybeSchema === "object" &&
          "model_json_schema" in maybeSchema &&
          typeof (maybeSchema as { model_json_schema: unknown })
            .model_json_schema === "function"
        ? (maybeSchema as { model_json_schema: () => unknown }).model_json_schema()
        : maybeSchema;

  const properties =
    resolved && typeof resolved === "object"
      ? (resolved as { properties?: unknown }).properties
      : undefined;
  return properties && typeof properties === "object"
    ? Object.keys(properties)
    : [];
}

function readGraphSchemaKeys(
  graph: any,
  names: string[],
  config?: Record<string, any>,
): string[] {
  for (const name of names) {
    const value = graph?.[name];
    if (typeof value !== "function") continue;
    try {
      return schemaKeysFrom(value.call(graph, config));
    } catch {
      continue;
    }
  }
  return [];
}

export function getGraphSchemaKeys(opts: {
  graph: any;
  config: Record<string, any>;
  constantSchemaKeys: string[];
}): SchemaKeys {
  const { graph, config, constantSchemaKeys } = opts;
  const inputKeys = readGraphSchemaKeys(
    graph,
    ["getInputJsonSchema", "get_input_jsonschema", "inputSchema"],
    config,
  );
  const outputKeys = readGraphSchemaKeys(
    graph,
    ["getOutputJsonSchema", "get_output_jsonschema", "outputSchema"],
    config,
  );
  const configKeys = readGraphSchemaKeys(
    graph,
    ["configSchema", "config_schema"],
    config,
  );
  const contextKeys = readGraphSchemaKeys(
    graph,
    ["contextSchema", "context_schema"],
    config,
  );

  return {
    input: [...inputKeys, ...constantSchemaKeys],
    output: [...outputKeys, ...constantSchemaKeys],
    config: configKeys,
    context: contextKeys,
  };
}
