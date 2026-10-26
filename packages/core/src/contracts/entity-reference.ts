/** Source-backed types opt into durable addressing by declaring one projected key. */
const RECORD_KEY_ANNOTATION = "x-lobu-record-key";

export function recordKeyColumn(schema: unknown): string | null {
  if (!schema || typeof schema !== "object") return null;
  const key = (schema as Record<string, unknown>)[RECORD_KEY_ANNOTATION];
  if (key === undefined) return null;
  if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(key)) {
    throw new Error(`${RECORD_KEY_ANNOTATION} must name one projected column`);
  }
  return key;
}

export function recordKey(
  row: Record<string, unknown>,
  column: string
): string | null {
  const value = row[column];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const key = String(value);
  return key.length > 0 && !key.includes("\0") ? key : null;
}
