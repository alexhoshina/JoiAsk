import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finished, startNode } from "./worker-cli.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const frontend = path.join(root, "frontend");

async function build(directory, name, args) {
  const require = createRequire(path.join(directory, "package.json"));
  const manifest = require.resolve(name + "/package.json");
  const { bin } = JSON.parse(await readFile(manifest, "utf8"));
  const entry = path.resolve(path.dirname(manifest), typeof bin === "string" ? bin : bin[name]);
  await finished(startNode(entry, args, {
    cwd: directory,
    env: { NEXT_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false" },
  }));
}

await build(frontend, "vite", ["build"]);
for (const name of ["admin", "docs"]) {
  const directory = path.join(root, name);
  await build(directory, "next", name === "docs" ? ["build", "--webpack"] : ["build"]);
  const target = path.join(root, "dist/client", name);
  await mkdir(target, { recursive: true });
  await cp(path.join(directory, "out"), target, { recursive: true });
  if (name === "admin") {
    const editor = path.join(directory, "node_modules/monaco-editor");
    await cp(path.join(editor, "min/vs"), path.join(target, "monaco/vs"), { recursive: true });
    for (const file of ["LICENSE", "ThirdPartyNotices.txt"]) {
      await cp(path.join(editor, file), path.join(target, "monaco", file));
    }
  }
}
