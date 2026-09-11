/**
 * Bounds for agent-facing query/list responses.
 *
 * The 4,000-character text head is the #2983 contract. The JSON-cell and
 * aggregate query_sql limits are internal serialization guards, deliberately
 * not configuration or public API: 16 KiB keeps nested values useful while
 * preventing one JSONB cell from dwarfing the text head, and the 1 MiB
 * response ceiling matches the existing sandbox script-output ceiling.
 */
export const CONTENT_TEXT_HEAD_CHARS = 4_000;
export const CONTENT_JSON_MAX_BYTES = 16 * 1024;
export const QUERY_SQL_RESULT_MAX_BYTES = 1_048_576;
/** Whole Automation envelope, matching the script-output cap and below the SDK bridge cap. */
export const AUTOMATION_READ_MAX_BYTES = 1_048_576;

const TRUNCATION_SUFFIX = '… [truncated]';
const SAFE_SQL_REF = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function sqlRef(value: string): string {
  if (!SAFE_SQL_REF.test(value)) throw new Error(`Unsafe SQL reference: ${value}`);
  return value;
}

/** SQL final projection for the canonical event text + truncation sidecars. */
export function boundedPayloadTextSql(alias: string): string {
  const a = sqlRef(alias);
  return (
    `CASE WHEN ${a}.content_length > ${CONTENT_TEXT_HEAD_CHARS} ` +
    `THEN left(${a}.payload_text, ${CONTENT_TEXT_HEAD_CHARS}) || '${TRUNCATION_SUFFIX}' ` +
    `ELSE ${a}.payload_text END AS payload_text, ` +
    `${a}.content_length, ` +
    `(${a}.content_length > ${CONTENT_TEXT_HEAD_CHARS}) AS payload_truncated`
  );
}

/** Replace one oversized JSON/JSONB object as a whole; never recursively walk it. */
export function boundedJsonSql(alias: string, column: string): string {
  const a = sqlRef(alias);
  const c = sqlRef(column);
  const ref = `${a}.${c}`;
  return (
    `CASE WHEN octet_length(${ref}::text) > ${CONTENT_JSON_MAX_BYTES} ` +
    `THEN jsonb_build_object('_truncated', true, 'bytes', octet_length(${ref}::text)) ` +
    `ELSE ${ref} END AS ${c}`
  );
}

/** Oversized attachment arrays become NULL plus explicit size sidecars. */
export function boundedAttachmentsSql(alias: string): string {
  const a = sqlRef(alias);
  const ref = `${a}.attachments`;
  return (
    `CASE WHEN octet_length(${ref}::text) > ${CONTENT_JSON_MAX_BYTES} ` +
    `THEN NULL ELSE ${ref} END AS attachments, ` +
    `(octet_length(${ref}::text) > ${CONTENT_JSON_MAX_BYTES}) AS attachments_truncated, ` +
    `CASE WHEN octet_length(${ref}::text) > ${CONTENT_JSON_MAX_BYTES} ` +
    `THEN octet_length(${ref}::text) ELSE NULL END AS attachments_bytes`
  );
}

/** `length` is the full PostgreSQL character count, needed only when truncating. */
type BoundedText =
  | { truncated: false }
  | { truncated: true; value: string; length: number };

function truncateByCodePoint(value: string): BoundedText {
  // A value whose UTF-16 unit count fits cannot exceed the code-point cap, so
  // the short path never pays for a code-point walk.
  if (value.length <= CONTENT_TEXT_HEAD_CHARS) return { truncated: false };

  let length = 0;
  let head = '';
  for (const character of value) {
    if (length < CONTENT_TEXT_HEAD_CHARS) head += character;
    length += 1;
  }
  if (length <= CONTENT_TEXT_HEAD_CHARS) return { truncated: false };
  return { value: `${head}${TRUNCATION_SUFFIX}`, length, truncated: true };
}

function jsonBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    // DB/connector rows should be JSON-serializable. If a connector violates
    // that contract, fail toward replacement rather than leaking an unbounded
    // object into the model response.
    return Number.POSITIVE_INFINITY;
  }
}

interface FinalizedDynamicRows {
  rows: Record<string, unknown>[];
  omittedRows: number;
  sidecarCollisions: string[];
}

function assignGeneratedSidecar(
  input: Record<string, unknown>,
  row: Record<string, unknown>,
  key: string,
  value: unknown,
  collisions: Set<string>
): void {
  if (
    (Object.prototype.hasOwnProperty.call(input, key) && input[key] !== value) ||
    (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== value)
  ) {
    collisions.add(key);
    return;
  }
  row[key] = value;
}

/**
 * The sole JS fallback for dynamic query_sql `SELECT *` results. SQL cannot
 * rewrite an unknown projection without coercing its types through JSON, so
 * bound its final cells here and then enforce one aggregate serialized ceiling.
 */
export function finalizeDynamicQueryRows(
  inputRows: Record<string, unknown>[],
  maxSerializedBytes = QUERY_SQL_RESULT_MAX_BYTES
): FinalizedDynamicRows {
  const boundedRows: Record<string, unknown>[] = [];
  const sidecarCollisions = new Set<string>();
  let serializedBytes = 2; // []

  for (const input of inputRows) {
    const row = { ...input };
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value === 'string') {
        const bounded = truncateByCodePoint(value);
        if (!bounded.truncated) continue;
        row[key] = bounded.value;
        if (key === 'payload_text' || key === 'text_content') {
          assignGeneratedSidecar(input, row, 'content_length', bounded.length, sidecarCollisions);
          assignGeneratedSidecar(input, row, 'payload_truncated', true, sidecarCollisions);
        }
        continue;
      }

      if (value === null || typeof value !== 'object') continue;
      const bytes = jsonBytes(value);
      if (bytes <= CONTENT_JSON_MAX_BYTES) continue;
      if (key === 'attachments') {
        row.attachments = null;
        assignGeneratedSidecar(input, row, 'attachments_truncated', true, sidecarCollisions);
        assignGeneratedSidecar(
          input,
          row,
          'attachments_bytes',
          Number.isFinite(bytes) ? bytes : null,
          sidecarCollisions
        );
      } else {
        row[key] = {
          _truncated: true,
          bytes: Number.isFinite(bytes) ? bytes : null,
        };
      }
    }

    const encoded = JSON.stringify(row);
    const rowBytes = Buffer.byteLength(encoded, 'utf8');
    const separatorBytes = boundedRows.length > 0 ? 1 : 0;
    if (serializedBytes + separatorBytes + rowBytes > maxSerializedBytes) break;
    boundedRows.push(row);
    serializedBytes += separatorBytes + rowBytes;
  }

  return {
    rows: boundedRows,
    omittedRows: inputRows.length - boundedRows.length,
    sidecarCollisions: [...sidecarCollisions].sort(),
  };
}
