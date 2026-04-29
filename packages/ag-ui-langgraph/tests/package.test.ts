import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type PackageJson = {
  main?: unknown;
  types?: unknown;
  exports?: Record<string, unknown>;
  files?: unknown;
  scripts?: Record<string, unknown>;
  license?: unknown;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

function readPackageJson(): PackageJson {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(resolve(testDir, "../package.json"), "utf8"),
  ) as PackageJson;
}

describe("package publishing metadata", () => {
  it("uses workspace source entrypoints and keeps publish metadata", () => {
    const pkg = readPackageJson();

    expect(pkg.main).toBe("./src/index.ts");
    expect(pkg.types).toBe("./src/index.ts");
    expect(pkg.exports?.["."]).toEqual({
      types: "./src/index.ts",
      import: "./src/index.ts",
      default: "./src/index.ts",
    });
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(pkg.files).toEqual(["dist", "src"]);
    expect(pkg.license).toBe("MIT");
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("has publish dry-run scripts and supervisor dependency", () => {
    const pkg = readPackageJson();

    expect(pkg.scripts?.prepack).toBe("pnpm run build");
    expect(pkg.scripts?.["publish:dry"]).toContain("npm pack --dry-run");
    expect(pkg.scripts?.["publish:dry"]).toContain(
      "--cache ../../node_modules/.cache/npm/ag-ui-langgraph",
    );
    expect(pkg.scripts?.["publish:check-name"]).toBe(
      "npm view ag-ui-langgraph version --registry=https://registry.npmjs.org",
    );
    expect(pkg.dependencies?.["@langchain/langgraph-supervisor"]).toBe(
      "^0.0.19",
    );
    expect(pkg.peerDependencies?.["@langchain/langgraph-supervisor"]).toBe(
      ">=0.0.19",
    );
  });
});
