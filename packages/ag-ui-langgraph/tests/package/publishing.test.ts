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
  homepage?: unknown;
  repository?: Record<string, unknown>;
  bugs?: Record<string, unknown>;
  publishConfig?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

function readPackageJson(): PackageJson {
  const testDir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(resolve(testDir, "../../package.json"), "utf8"),
  ) as PackageJson;
}

describe("package publishing metadata", () => {
  it("publishes compiled dist entrypoints and keeps public metadata", () => {
    const pkg = readPackageJson();

    expect(pkg.main).toBe("./dist/index.js");
    expect(pkg.types).toBe("./dist/index.d.ts");
    expect(pkg.exports?.["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    });
    expect(pkg.exports?.["./package.json"]).toBe("./package.json");
    expect(pkg.files).toEqual(["dist", "README.md", "LICENSE"]);
    expect(pkg.license).toBe("MIT");
    expect(pkg.homepage).toBe(
      "https://github.com/Tsutomu-miku/ag-ui-chat-demo#readme",
    );
    expect(pkg.repository).toEqual({
      type: "git",
      url: "git+https://github.com/Tsutomu-miku/ag-ui-chat-demo.git",
      directory: "packages/ag-ui-langgraph",
    });
    expect(pkg.bugs?.url).toBe(
      "https://github.com/Tsutomu-miku/ag-ui-chat-demo/issues",
    );
    expect(pkg.publishConfig?.access).toBe("public");
  });

  it("has publish dry-run scripts and supervisor dependency", () => {
    const pkg = readPackageJson();

    expect(pkg.scripts?.prepack).toBe("pnpm run build");
    expect(pkg.scripts?.test).toBe("vitest run");
    expect(pkg.scripts?.["test:coverage"]).toBe("vitest run --coverage");
    expect(pkg.scripts?.prepublishOnly).toBe(
      "pnpm run typecheck && pnpm run test:coverage && pnpm run build",
    );
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
