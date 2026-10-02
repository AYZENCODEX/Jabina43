import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const validator = fileURLToPath(new URL("validate-common.mjs", import.meta.url));
const result = spawnSync(process.execPath, [validator, "00", "C"], { stdio: "inherit" });
process.exit(result.status ?? 1);
