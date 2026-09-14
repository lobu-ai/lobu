import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Minimal .env file parser shared across Lobu CLIs.
 *
 * Skips blank lines and comments, supports `KEY=VALUE` pairs, strips a single
 * pair of surrounding double or single quotes, and validates the key against
 * the POSIX-style shell identifier pattern. Later occurrences of the same key
 * overwrite earlier ones (matching `dotenv` semantics).
 */
export function parseEnvContent(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}

/**
 * Read the project `.env` in `cwd`, falling back to {} when the file is
 * absent. Shell environment always wins — callers check `process.env` first
 * and use this only as the project-local fallback.
 */
export async function readProjectEnvFile(
  cwd: string
): Promise<Record<string, string>> {
  try {
    const raw = await readFile(join(cwd, ".env"), "utf-8");
    return parseEnvContent(raw);
  } catch {
    return {};
  }
}

/** Read one variable from the project `.env` in `cwd` ("" when absent). */
export async function readProjectEnvValue(
  cwd: string,
  key: string
): Promise<string> {
  const env = await readProjectEnvFile(cwd);
  return env[key]?.trim() ?? "";
}
