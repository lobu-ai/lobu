import { createHash } from "node:crypto";

export interface SourceRef {
  feed_id: number;
  connection_id: number;
  origin_id: string;
  observed_at: string;
}
export interface Observation {
  provider: "gmail" | "linkedin" | "whatsapp" | "x";
  account_scope: string;
  namespace: string;
  native_key: string;
  source_refs: SourceRef[];
  display_names?: string[];
  person_ids?: number[];
  held?: boolean;
}
export interface AliasEvidence {
  left: string;
  right: string;
  kind: "same_row" | "redirect";
  source_ref: SourceRef;
}
export interface IdentityInput {
  observations: Observation[];
  aliases?: AliasEvidence[];
}
export interface IdentityItem {
  slug: string;
  name: string;
  metadata: Record<string, unknown>;
  person_ids: number[];
  person_field?: string;
}
export interface IdentityManifest {
  version: 1;
  items: IdentityItem[];
  aliases: { from: string; to: string; import_key: string; basis: string }[];
}

const fields: Record<string, string> = {
  "gmail:mailbox": "email",
  "x:handle": "x_handle",
  "x:user-id": "x_user_id",
  "linkedin:slug": "linkedin_slug",
  "linkedin:opaque": "linkedin_member_id",
  "whatsapp:phone": "phone",
  "whatsapp:jid": "wa_jid",
};
const namespaces = new Set([
  ...Object.keys(fields),
  "linkedin:page",
  "whatsapp:group",
  "whatsapp:lid",
]);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = <T>(values: T[]) => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
];

export function normalizeKey(namespace: string, key: string): string {
  if (typeof key !== "string" || !key.trim())
    throw new Error("Missing native key");
  const value = key.trim();
  if (namespace === "gmail:mailbox") {
    if (!/^[^\s<>@]+@[^\s<>@]+$/.test(value))
      throw new Error("Expected a parsed mailbox address, not a raw header");
    return value.toLowerCase(); // Never strip plus tags or infer provider aliases.
  }
  if (namespace === "x:handle") {
    if (!/^@?[a-zA-Z0-9_]{1,15}$/.test(value))
      throw new Error("Invalid X handle");
    return value.replace(/^@/, "").toLowerCase();
  }
  if (namespace === "x:user-id") {
    if (!/^[0-9]+$/.test(value))
      throw new Error("Expected a native numeric X user ID");
    return value;
  }
  if (namespace === "linkedin:opaque") {
    if (!/^[a-zA-Z0-9_-]+$/.test(value))
      throw new Error("Invalid native account ID");
    return value;
  }
  if (namespace === "linkedin:slug") {
    if (!/^[a-zA-Z0-9_%.-]+$/.test(value))
      throw new Error("Expected a profile slug, not a URL");
    return value.toLowerCase();
  }
  if (namespace === "whatsapp:phone") {
    if (!/^\+?[0-9]{6,15}$/.test(value))
      throw new Error(
        "Phone must include international digits without inferred country codes"
      );
    return value.replace(/^\+/, "");
  }
  if (
    namespace === "whatsapp:jid" &&
    !/^[0-9]{6,15}@(?:c\.us|s\.whatsapp\.net)$/.test(value)
  )
    throw new Error("Not an individual phone JID");
  if (namespace === "whatsapp:group" && !/^[0-9-]+@g\.us$/.test(value))
    throw new Error("Invalid group JID");
  if (namespace === "whatsapp:lid" && !/^[0-9]+@lid$/.test(value))
    throw new Error("Invalid LID");
  return value;
}

export function observationKey(
  row: Pick<Observation, "namespace" | "account_scope" | "native_key">
): string {
  if (!row.account_scope?.trim())
    throw new Error("Explicit account_scope required; no default account");
  return hash([
    row.namespace,
    row.account_scope,
    normalizeKey(row.namespace, row.native_key),
  ]);
}

function sourceRef(ref: SourceRef): SourceRef {
  if (
    !Number.isSafeInteger(ref.feed_id) ||
    ref.feed_id <= 0 ||
    !Number.isSafeInteger(ref.connection_id) ||
    ref.connection_id <= 0 ||
    typeof ref.origin_id !== "string" ||
    !ref.origin_id ||
    !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(ref.observed_at) ||
    !Number.isFinite(Date.parse(ref.observed_at))
  ) {
    throw new Error(
      "Reference requires feed, connection, native origin_id and observed_at"
    );
  }
  // Projection before persistence: bodies, subjects, snippets and arbitrary fields
  // cannot pass through even if callers supply them on their input objects.
  return {
    feed_id: ref.feed_id,
    connection_id: ref.connection_id,
    origin_id: ref.origin_id,
    observed_at: ref.observed_at,
  };
}

export function buildManifest(input: IdentityInput): IdentityManifest {
  if (!Array.isArray(input.observations) || !input.observations.length)
    throw new Error("No observations supplied");
  const byKey = new Map<string, IdentityItem>();
  for (const row of input.observations) {
    if (
      !namespaces.has(row.namespace) ||
      !row.namespace.startsWith(`${row.provider}:`)
    )
      throw new Error("Unknown or cross-provider namespace");
    const nativeKey = normalizeKey(row.namespace, row.native_key);
    const key = observationKey(row);
    if (!Array.isArray(row.source_refs) || !row.source_refs.length)
      throw new Error("Observation requires source evidence");
    const refs = row.source_refs.map(sourceRef);
    const names = unique(row.display_names ?? []);
    if (names.some((name) => typeof name !== "string" || name.length > 300))
      throw new Error("Invalid display name");
    const ids = row.held ? [] : unique(row.person_ids ?? []);
    if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error("Invalid existing person ID");
    const prior = byKey.get(key);
    if (prior && (row.held || prior.metadata.held)) {
      prior.person_ids = [];
      prior.metadata.held = true;
    }
    const metadata = {
      provider: row.provider,
      namespace: row.namespace,
      native_key: nativeKey,
      account_scope: row.account_scope,
      kind: row.namespace.split(":")[1],
      import_key: key,
      certainty: "source observation; not a verified human",
      classification: "unknown",
      display_names: unique([
        ...((prior?.metadata.display_names as string[]) ?? []),
        ...names,
      ]).sort(),
      source_refs: unique([
        ...((prior?.metadata.source_refs as SourceRef[]) ?? []),
        ...refs,
      ]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
    const dates = metadata.source_refs
      .map((r) => r.observed_at)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    byKey.set(key, {
      slug: `ci-${key.slice(0, 32)}`,
      name: `${nativeKey} — ${row.provider}`,
      metadata: {
        ...metadata,
        first_observed_at: dates[0],
        last_observed_at: dates.at(-1),
      },
      person_ids:
        prior?.metadata.held || row.held
          ? []
          : unique([...(prior?.person_ids ?? []), ...ids]).sort(
              (a, b) => a - b
            ),
      person_field: fields[row.namespace],
    });
    // Review holds are input control state, not new persisted metadata fields.
    if (prior?.metadata.held || row.held) byKey.get(key)!.metadata.held = true;
  }
  const aliases: IdentityManifest["aliases"] = [];
  const claimed = new Set<string>();
  for (const evidence of input.aliases ?? []) {
    const left = byKey.get(evidence.left),
      right = byKey.get(evidence.right);
    if (!left || !right || left === right)
      throw new Error("Alias endpoints must be two observed identifiers");
    const a = left.metadata,
      b = right.metadata;
    if (a.provider !== b.provider || a.account_scope !== b.account_scope)
      throw new Error("Cross-account alias evidence refused");
    const pair = [left, right].sort((x, y) =>
      String(x.metadata.namespace).localeCompare(String(y.metadata.namespace))
    );
    const [first, second] = pair;
    const ns = pair.map((item) => item.metadata.namespace).join("|");
    const ref = sourceRef(evidence.source_ref);
    if (
      !pair.every((item) =>
        (item.metadata.source_refs as SourceRef[]).some(
          (r) => JSON.stringify(r) === JSON.stringify(ref)
        )
      )
    )
      throw new Error("Alias evidence must occur on both source observations");
    let representative: IdentityItem;
    if (
      evidence.kind === "same_row" &&
      ns === "whatsapp:jid|whatsapp:phone" &&
      String(first.metadata.native_key).split("@")[0] ===
        second.metadata.native_key
    )
      representative = first;
    else if (evidence.kind === "same_row" && ns === "x:handle|x:user-id")
      representative = second;
    else if (
      evidence.kind === "redirect" &&
      ns === "linkedin:opaque|linkedin:slug"
    )
      representative = first;
    else
      throw new Error(
        "Unsupported alias evidence; names, groups and LIDs cannot establish equivalence"
      );
    if (pair.some((item) => claimed.has(item.slug)))
      throw new Error("Identifier reuse or conflicting alias evidence");
    for (const item of pair) claimed.add(item.slug);
    const canonical = hash([
      a.provider,
      a.account_scope,
      representative.metadata.namespace,
      representative.metadata.native_key,
    ]);
    for (const item of pair)
      item.metadata.canonical_source_account_key = canonical;
    const member = pair.find((item) => item !== representative)!;
    aliases.push({
      from: member.slug,
      to: representative.slug,
      import_key: canonical,
      basis: evidence.kind,
    });
  }
  for (const item of byKey.values()) delete item.metadata.held;
  return {
    version: 1,
    items: [...byKey.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    aliases: aliases.sort((a, b) => a.from.localeCompare(b.from)),
  };
}
