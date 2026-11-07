import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (!args.includes("--org")) {
  throw new Error(
    "Select the intended workspace explicitly: bun run demo:seed --org <slug> [--context <name>]."
  );
}
const script = readFileSync(new URL("../demo.ts", import.meta.url), "utf8");
const result = spawnSync(
  "lobu",
  [
    "call",
    "run_sdk",
    "--arg",
    "title=Seed synthetic legal demo",
    "--arg",
    `script=${script}`,
    ...args,
  ],
  { stdio: "inherit" }
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
