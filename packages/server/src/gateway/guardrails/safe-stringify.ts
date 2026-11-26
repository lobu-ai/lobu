/**
 * Best-effort JSON serializer for pre-tool arguments. Tool args occasionally
 * contain BigInt values (native JSON throws) or circular object graphs (also
 * throws). On any failure return a placeholder string rather than letting the
 * exception escape: the guardrail runner treats a thrown guardrail as a pass,
 * which would silently weaken pii-scan on exactly the inputs
 * weird enough to deserve scrutiny.
 *
 * Invariant: always returns a string. Callers run `.match()` on the result,
 * which would throw on `undefined` — and `JSON.stringify` returns `undefined`
 * for top-level non-serializable primitives (a bare function, `undefined`,
 * etc.).
 */
export function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const replacer = (_key: string, v: unknown): unknown => {
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "object" && v !== null) {
      if (seen.has(v)) return "<circular>";
      seen.add(v);
    }
    return v;
  };
  try {
    const result = JSON.stringify(value, replacer);
    return typeof result === "string" ? result : "<unserializable>";
  } catch {
    return "<unserializable>";
  }
}
