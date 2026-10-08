import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

// Match against the complete live population before the caller adds keyset
// pagination. A person may belong to several groups; no CASE priority drops
// their other evidence. Associated records retain their own evidence here; this
// reporting Automation never changes identity relationships.
export const duplicateCandidateQuery = `
WITH people AS (
  SELECT id, name,
    regexp_replace(lower(trim(coalesce(name, ''))), '[^a-z0-9]', '', 'g') AS name_key,
    nullif(lower(trim(metadata->>'email')), '') AS email,
    nullif(regexp_replace(coalesce(metadata->>'phone', ''), '[^0-9]', '', 'g'), '') AS phone,
    jsonb_strip_nulls(jsonb_build_object(
      'company', metadata->'company', 'position', metadata->'position',
      'linkedin_url', metadata->'linkedin_url', 'x_handle', metadata->'x_handle',
      'x_display_name', metadata->'x_display_name', 'push_name', metadata->'push_name',
      'ig_username', metadata->'ig_username', 'instagram_profile_url', metadata->'instagram_profile_url'
    )) AS context
  FROM entities
  WHERE entity_type = 'person' AND deleted_at IS NULL
    AND lower(coalesce(metadata->>'email', '')) NOT LIKE '%@example.test'
), signals AS (
  SELECT p.id, 'name:' || p.name_key AS reason FROM people p WHERE p.name_key <> ''
  UNION ALL
  SELECT p.id, 'email:' || p.email AS reason FROM people p WHERE p.email IS NOT NULL
  UNION ALL
  SELECT p.id, 'phone:' || p.phone AS reason FROM people p WHERE length(p.phone) >= 7
), counted AS (
  SELECT s.id, s.reason, count(*) OVER (PARTITION BY s.reason) AS members FROM signals s
), matches AS (
  SELECT c.id, jsonb_agg(c.reason ORDER BY c.reason) AS match_reasons
  FROM counted c WHERE c.members > 1 GROUP BY c.id
)
SELECT p.id, p.name, p.name_key, m.match_reasons,
  p.context || jsonb_strip_nulls(jsonb_build_object('email', p.email, 'phone', p.phone)) AS evidence
FROM people p JOIN matches m ON m.id = p.id
ORDER BY p.id
`;

export const input = {
  type: "object",
  properties: {
    analysis_summary: { type: "string" },
    uncertain_groups: { type: "array", items: { type: "object" } },
  },
  required: ["analysis_summary", "uncertain_groups"],
  additionalProperties: false,
} as const;

type Candidate = {
  id: number;
  name: string;
  match_reasons: string[];
  evidence: Record<string, unknown>;
};

// Object keys and evidence sets have no semantic order. Incidental entity
// timestamps and interaction counters are excluded by the SQL projection.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value) ?? "null";
}

export default async function reportDuplicates(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<{ group_count: number; candidate_count: number }> {
  const candidates: Candidate[] = [];
  let after = 0;
  // client.query caps rows on its own. Page by id until an empty page so a cap
  // can never be mistaken for the end of the candidate set.
  while (true) {
    const page = (await client.query(
      `SELECT * FROM (${duplicateCandidateQuery}) candidates WHERE id > ${after} ORDER BY id LIMIT 500`
    )) as Candidate[];
    if (!page.length) break;
    for (const row of page) {
      const id = Number(row.id);
      if (!Number.isSafeInteger(id) || id <= after) {
        throw new Error("Duplicate candidate pagination did not advance");
      }
      candidates.push({ ...row, id });
      after = id;
    }
  }
  const groups = new Map<string, Candidate[]>();
  for (const row of candidates) {
    for (const reason of row.match_reasons) {
      const group = groups.get(reason) ?? [];
      group.push(row);
      groups.set(reason, group);
    }
  }
  const orderedGroups = [...groups].sort(([a], [b]) => a.localeCompare(b));
  const evidence = candidates.map(({ id, name, match_reasons, evidence }) => ({
    id,
    name,
    match_reasons,
    evidence,
  }));
  // client.query compiles {{placeholders}} and rejects $1 text even inside a
  // literal, so contact text is percent-encoded before it reaches SQL.
  const literal = encodeURIComponent(canonical(evidence)).replaceAll("'", "''");
  const [hash] = (await client.query(
    `SELECT md5('${literal}') AS digest`
  )) as Array<{ digest: string }>;
  if (!hash || !/^[a-f0-9]{32}$/.test(hash.digest)) {
    throw new Error("Could not fingerprint duplicate report evidence");
  }
  const fingerprint = hash.digest;
  const summary = [
    `Duplicate candidate groups: ${groups.size} (candidates: ${candidates.length}).`,
    "Candidates need review; this report does not associate contacts.",
    ...orderedGroups
      .slice(0, 12)
      .map(
        ([reason, members]) =>
          `- ${reason}: ${members.map((m) => `${m.name || "Unnamed"} (#${m.id})`).join(", ")}`
      ),
    ...(groups.size > 12 ? [`…and ${groups.size - 12} more groups.`] : []),
  ].join("\n");
  const automation_source = {
    automation_id: ctx.automation.id,
    run_id: ctx.window.run_id,
  };
  const key = `duplicate-resolution:${ctx.automation.id}:v2:${fingerprint}`;
  // The existing indexed idempotency keys serialize concurrent reactions and
  // retries. No history scan or read-before-write decides whether to notify.
  await client.knowledge.save({
    content: summary,
    semantic_type: "summary",
    title: `Duplicate candidates · ${String(ctx.window.window_end).slice(0, 10)}`,
    payload_type: "markdown",
    metadata: {
      schema: "duplicate-candidates/v2",
      fingerprint,
      group_count: groups.size,
      candidate_count: candidates.length,
      groups: orderedGroups.map(([reason, members]) => ({
        reason,
        ids: members.map((m) => m.id),
      })),
      candidates: evidence,
    },
    occurred_at: ctx.window.window_end,
    idempotency_key: `${key}:report`,
    automation_source,
  });
  await client.notifications.send({
    title: candidates.length
      ? "Duplicate contacts need review"
      : "No duplicate candidates remain",
    body: summary.slice(0, 1000),
    idempotency_key: `${key}:notify`,
    automation_source,
  });
  return { group_count: groups.size, candidate_count: candidates.length };
}
