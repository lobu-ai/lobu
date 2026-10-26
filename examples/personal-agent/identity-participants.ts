import {
  type IdentityInput,
  normalizeKey,
  type Observation,
  observationKey,
  type SourceRef,
} from "./identity-bootstrap.ts";

export interface ParticipantSource {
  provider: "linkedin" | "whatsapp" | "x";
  account_scope: string;
  feed_id: number;
  connection_id: number;
}
export interface ParticipantRow {
  origin_id: string;
  observed_at: string;
  connection_id?: number;
  metadata: Record<string, unknown>;
}

// Offline extraction from body-free projected native metadata. It never reads a
// browser or creates a person. Callers verify the saved account before/after
// source collection, and persist their actual source continuations separately.
export function extractParticipants(
  source: ParticipantSource,
  rows: ParticipantRow[]
): IdentityInput {
  if (!source.account_scope?.trim())
    throw new Error("Account binding required");
  const observations: Observation[] = [],
    aliases = new Map<string, NonNullable<IdentityInput["aliases"]>[number]>();
  for (const row of rows) {
    if (
      row.connection_id !== undefined &&
      row.connection_id !== source.connection_id
    )
      throw new Error("Source account/connection changed");
    const m = row.metadata;
    if (m.from_me === true || m.from_me === "true") continue;
    const ref: SourceRef = {
      feed_id: source.feed_id,
      connection_id: source.connection_id,
      origin_id: row.origin_id,
      observed_at: row.observed_at,
    };
    const add = (namespace: string, value: unknown, name?: unknown) => {
      if (value === undefined || value === null || value === "")
        return undefined;
      if (typeof value !== "string")
        throw new Error(
          "Native identifiers must be strings, never floating-point numbers"
        );
      const observation: Observation = {
        provider: source.provider,
        account_scope: source.account_scope,
        namespace,
        native_key: normalizeKey(namespace, value),
        source_refs: [ref],
        ...(typeof name === "string" ? { display_names: [name] } : {}),
      };
      observations.push(observation);
      return observation;
    };
    const sameRow = (a?: Observation, b?: Observation) => {
      if (!a || !b) return;
      const left = observationKey(a),
        right = observationKey(b);
      aliases.set(`${left}:${right}`, {
        left,
        right,
        kind: "same_row",
        source_ref: ref,
      });
    };
    if (source.provider === "whatsapp") {
      const jid = typeof m.sender_jid === "string" ? m.sender_jid : undefined;
      const namespace = jid?.endsWith("@lid") ? "whatsapp:lid" : "whatsapp:jid";
      const sender = add(namespace, m.sender_jid, m.push_name);
      const phone = add("whatsapp:phone", m.sender_phone, m.push_name);
      if (namespace === "whatsapp:jid" && sender && phone) {
        if (sender.native_key.split("@")[0] !== phone.native_key)
          throw new Error("JID and explicit phone disagree");
        sameRow(sender, phone);
      }
      if (m.is_group === true || m.is_group === "true")
        add("whatsapp:group", m.chat_jid);
    } else if (source.provider === "x") {
      const id = add("x:user-id", m.sender_id);
      const handle = add("x:handle", m.sender_handle ?? m.handle);
      sameRow(id, handle);
    } else {
      // Member IDs and vanity observations are retained independently; no
      // opaque/vanity alias is invented without an observed redirect.
      add("linkedin:opaque", m.sender_member_id, m.sender_name);
      add("linkedin:slug", m.sender_slug, m.sender_name);
    }
  }
  return { observations, aliases: [...aliases.values()] };
}
