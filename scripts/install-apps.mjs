import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Keep the three framework dependency trees independent (including their React versions).
for (const app of ["frontend", "admin", "docs"]) {
  const cwd = fileURLToPath(new URL("../" + app + "/", import.meta.url));
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "ci", "--include=dev", "--no-fund", "--no-audit"], {
    cwd,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
