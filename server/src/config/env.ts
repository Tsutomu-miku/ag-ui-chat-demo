import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(currentDir, "../..");
const workspaceDir = resolve(serverDir, "..");

config({ path: resolve(workspaceDir, ".env") });
config({ path: resolve(serverDir, ".env") });
