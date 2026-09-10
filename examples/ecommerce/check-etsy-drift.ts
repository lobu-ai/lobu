import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeContracts } from "./etsy.connector";

// Run with Bun. No spec download or code generation occurs during connector startup.
// Set ETSY_SPEC_PATH only for offline/reproducible checks; the default is live Etsy.
const response = process.env.ETSY_SPEC_PATH
  ? JSON.parse(readFileSync(process.env.ETSY_SPEC_PATH, "utf8"))
  : await fetch("https://www.etsy.com/openapi/generated/oas/3.0.0.json", {
      signal: AbortSignal.timeout(30000),
    }).then((r) => {
      if (!r.ok) throw new Error(`Etsy spec unavailable: HTTP ${r.status}`);
      return r.json();
    });
function normalize(value: any, properties = false): any {
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter(
          (key) =>
            properties || !["description", "format", "default"].includes(key)
        )
        .map((key) => [key, normalize(value[key], key === "properties")])
    );
  return value;
}
const canonical = (value: unknown) => JSON.stringify(normalize(value));
for (const contract of Object.values(writeContracts)) {
  const operation =
    response.paths[`/v3/application/${contract.path}`]?.[
      contract.method.toLowerCase()
    ];
  if (
    !operation ||
    operation.operationId !== contract.operationId ||
    !operation.security?.some((entry: any) =>
      entry.oauth2?.includes(contract.scope)
    ) ||
    canonical(operation.requestBody?.content?.[contract.media]?.schema) !==
      canonical(contract.schema)
  )
    throw new Error(
      `Etsy request contract drift: ${contract.operationId}. Review before updating the connector.`
    );
}
// References are included transitively so response/parameter changes are visible.
function resolved(value: any, seen = new Set<string>()): any {
  if (Array.isArray(value)) return value.map((item) => resolved(item, seen));
  if (!value || typeof value !== "object") return value;
  if (value.$ref && !seen.has(value.$ref)) {
    const next = new Set(seen);
    next.add(value.$ref);
    return resolved(
      value.$ref
        .split("/")
        .slice(1)
        .reduce((node: any, key: string) => node[key], response),
      next
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, resolved(item, seen)])
  );
}
const expected: Record<string, string> = JSON.parse(
  readFileSync(new URL("./etsy-contracts.json", import.meta.url), "utf8")
);
for (const [id, hash] of Object.entries(expected)) {
  const operation = Object.values(response.paths)
    .flatMap((path: any) => Object.values(path))
    .find((op: any) => op.operationId === id);
  if (!operation) throw new Error(`Etsy operation removed: ${id}`);
  const actual = createHash("sha256")
    .update(canonical(resolved(operation)))
    .digest("hex");
  if (actual !== hash)
    throw new Error(
      `Etsy API contract drift: ${id}. Check parameters, scopes and responses; do not blindly refresh the snapshot.`
    );
}
console.log(
  `Etsy contract verification passed: ${Object.keys(expected).length} operations.`
);
