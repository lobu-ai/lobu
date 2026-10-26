import type { IdentityItem, IdentityManifest } from "./identity-bootstrap.ts";

// Structural subset of the existing SDK, also usable by synthetic stores. This
// is example code, not an SDK extension. The function is self-contained so the
// CLI can send its compiled JavaScript to the authenticated run_sdk tool.
export interface IdentityClient {
  query(sql: string): Promise<unknown>;
  entities: {
    get(input: { entity_id: number }): Promise<unknown>;
    create(input: Record<string, unknown>): Promise<unknown>;
    update(input: Record<string, unknown>): Promise<unknown>;
    listLinks(input: Record<string, unknown>): Promise<unknown>;
    link(input: Record<string, unknown>): Promise<unknown>;
  };
}
export interface ImportChunk {
  items: IdentityItem[];
  aliases: IdentityManifest["aliases"];
}

export async function runIdentityChunk(
  client: IdentityClient,
  chunk: ImportChunk,
  verify: boolean
) {
  type Row = Record<string, any>;
  const object = (value: unknown): Row => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Malformed SDK result");
    return value as Row;
  };
  const check = (value: unknown): Row => {
    const result = object(value);
    if (
      result.success === false ||
      result.isError ||
      result.truncated ||
      result.error ||
      result.approval_queued ||
      result.authorization_status === "pending_approval" ||
      result.status === "pending_approval" ||
      (Array.isArray(result.blocked_fields) && result.blocked_fields.length)
    )
      throw new Error(
        "SDK mutation failed or requires human approval; read back before resuming"
      );
    return result;
  };
  const stable = (value: any): string =>
    JSON.stringify(value, (_key, entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))
          )
        : entry
    );
  const union = (a: any[], b: any[]) =>
    [
      ...new Map([...a, ...b].map((entry) => [stable(entry), entry])).values(),
    ].sort((x, y) => stable(x).localeCompare(stable(y)));
  const slugs = [
    ...new Set([
      ...chunk.items.map((item) => item.slug),
      ...chunk.aliases.flatMap((edge) => [edge.from, edge.to]),
    ]),
  ];
  if (
    slugs.length > 200 ||
    slugs.some((slug) => !/^ci-[a-f0-9]{32}$/.test(slug))
  )
    throw new Error("Invalid or oversized identity chunk");
  if (!slugs.length) return { records: [], edges: [] };
  // Read raw stored members: entities.list enumerates identity roots and would
  // silently miss aliases on replay after source-account grouping.
  const rows = await client.query(
    `SELECT id, slug, metadata FROM entities WHERE entity_type = 'contact-identity' AND slug IN (${slugs.map((slug) => `'${slug}'`).join(",")}) ORDER BY id LIMIT 500`
  );
  if (!Array.isArray(rows)) throw new Error("Malformed identity readback");
  const live = new Map<string, Row>();
  for (const row of rows) {
    const entity = object(row);
    if (
      !slugs.includes(entity.slug) ||
      !Number.isSafeInteger(entity.id) ||
      live.has(entity.slug)
    )
      throw new Error("Unexpected or duplicate identity readback");
    live.set(entity.slug, entity);
  }
  const records: { slug: string; id: number; action: string }[] = [];
  const requireMetadata = (entity: Row, item: IdentityItem) => {
    const metadata = object(entity.metadata);
    for (const key of [
      "provider",
      "namespace",
      "native_key",
      "account_scope",
      "import_key",
    ]) {
      if (metadata[key] !== item.metadata[key])
        throw new Error(`Identity collision: ${item.slug}/${key}`);
    }
    if (
      metadata.canonical_source_account_key &&
      item.metadata.canonical_source_account_key &&
      metadata.canonical_source_account_key !==
        item.metadata.canonical_source_account_key
    )
      throw new Error("Conflicting canonical source-account key");
    return metadata;
  };
  for (const item of chunk.items) {
    let entity = live.get(item.slug);
    let action = "adopted";
    if (!entity) {
      if (verify) throw new Error(`Missing identity: ${item.slug}`);
      const response = check(
        await client.entities.create({
          entity_type: "contact-identity",
          slug: item.slug,
          name: item.name,
          metadata: item.metadata,
        })
      );
      entity = object(response.entity ?? response);
      if (!Number.isSafeInteger(entity.id))
        throw new Error(
          "Missing created ID; reconcile this slug before resuming"
        );
      action = "created";
    }
    const read = check(await client.entities.get({ entity_id: entity.id }));
    entity = object(read.entity ?? read);
    let metadata = requireMetadata(entity, item);
    const dates = [
      ...(metadata.source_refs ?? []),
      ...(item.metadata.source_refs as any[]),
    ]
      .map((ref) => ref.observed_at)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    const merged = {
      ...metadata,
      display_names: union(
        metadata.display_names ?? [],
        item.metadata.display_names as any[]
      ),
      source_refs: union(
        metadata.source_refs ?? [],
        item.metadata.source_refs as any[]
      ),
      first_observed_at: dates[0],
      last_observed_at: dates.at(-1),
      ...(item.metadata.canonical_source_account_key
        ? {
            canonical_source_account_key:
              item.metadata.canonical_source_account_key,
          }
        : {}),
    };
    if (stable(metadata) !== stable(merged)) {
      if (verify) throw new Error(`Missing metadata/evidence: ${item.slug}`);
      check(
        await client.entities.update({
          entity_id: entity.id,
          metadata: merged,
        })
      );
      const updated = check(
        await client.entities.get({ entity_id: entity.id })
      );
      const persisted = object(updated.entity ?? updated);
      metadata = requireMetadata(persisted, item);
      if (stable(metadata) !== stable(merged))
        throw new Error("Metadata update not persisted exactly");
      action = action === "created" ? action : "updated";
    }
    live.set(item.slug, { ...entity, metadata });
    records.push({ slug: item.slug, id: entity.id, action });
  }
  const edges: { from: number; to: number; type: string; action: string }[] =
    [];
  const allLinks = async (id: number, type: string): Promise<Row[]> => {
    const out: Row[] = [];
    for (let offset = 0; offset < 10000; offset += 200) {
      const page = check(
        await client.entities.listLinks({
          entity_id: id,
          relationship_type_slug: type,
          limit: 200,
          offset,
        })
      );
      if (!Array.isArray(page.relationships))
        throw new Error("Missing relationships readback");
      out.push(...page.relationships);
      if (page.relationships.length < 200) return out;
    }
    throw new Error("Relationship pagination budget exceeded");
  };
  const edge = async (
    from: number,
    to: number,
    type: string,
    key: string,
    basis: string
  ) => {
    const find = (rows: Row[]) =>
      rows.filter(
        (row) =>
          row.from_entity_id === from &&
          row.to_entity_id === to &&
          row.relationship_type_slug === type &&
          !row.deleted_at
      );
    let found = find(await allLinks(from, type));
    const action = found.length ? "adopted" : "linked";
    if (!found.length) {
      if (verify) throw new Error("Missing expected relationship");
      check(
        await client.entities.link({
          from_entity_id: from,
          to_entity_id: to,
          relationship_type_slug: type,
          source: "api",
          confidence: 1,
          metadata: {
            import_key: key,
            basis,
            evidence_status:
              type === "matches_contact_field"
                ? "contact-field evidence; not a person merge"
                : "structurally proven source-account alias",
          },
        })
      );
      found = find(await allLinks(from, type));
    }
    if (
      found.length !== 1 ||
      !Number.isSafeInteger(found[0].id) ||
      found[0].metadata?.import_key !== key ||
      found[0].metadata?.basis !== basis
    )
      throw new Error("Relationship readback mismatch");
    edges.push({ from, to, type, action });
  };
  for (const item of chunk.items) {
    for (const id of item.person_ids) {
      const result = check(await client.entities.get({ entity_id: id }));
      const person = object(result.entity ?? result);
      const actual = person.metadata?.[item.person_field ?? ""];
      const expected = item.metadata.native_key;
      const normalize = (value: unknown) => {
        if (typeof value !== "string") return value;
        const trimmed = value.trim();
        if (item.person_field === "phone") return trimmed.replace(/^\+/, "");
        if (item.person_field === "x_handle")
          return trimmed.replace(/^@/, "").toLowerCase();
        if (
          item.person_field === "email" ||
          item.person_field === "linkedin_slug"
        )
          return trimmed.toLowerCase();
        return trimmed;
      };
      if (
        person.entity_type !== "person" ||
        !item.person_field ||
        normalize(actual) !== normalize(expected)
      )
        throw new Error("Person target lacks exact contact-field evidence");
      await edge(
        live.get(item.slug)!.id,
        id,
        "matches_contact_field",
        String(item.metadata.import_key),
        `exact ${item.person_field}`
      );
    }
  }
  for (const alias of chunk.aliases) {
    const from = live.get(alias.from),
      to = live.get(alias.to);
    if (
      !from ||
      !to ||
      from.metadata.canonical_source_account_key !== alias.import_key ||
      to.metadata.canonical_source_account_key !== alias.import_key ||
      from.metadata.account_scope !== to.metadata.account_scope ||
      from.metadata.provider !== to.metadata.provider
    )
      throw new Error("Alias endpoints do not share the proven scoped key");
    await edge(
      from.id,
      to.id,
      "same_source_account",
      alias.import_key,
      alias.basis
    );
    for (const id of [from.id, to.id]) {
      const result = check(await client.entities.get({ entity_id: id }));
      const entity = object(result.entity ?? result);
      if (
        !entity.identity?.member_ids?.includes(from.id) ||
        !entity.identity?.member_ids?.includes(to.id)
      )
        throw new Error("Alias grouping did not persist");
    }
  }
  return { records, edges };
}
