import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

const LINKEDIN_CONNECTION_SLUG = "linkedin-buremba";
const MAX_FLAGS = 5;
const POST_URL =
  /^https:\/\/www\.linkedin\.com\/feed\/update\/urn:li:(activity|ugcPost|share):\d+\/?$/;

type Flag = {
  post_url: string;
  draft: string;
  why: string;
  author: string;
  gist: string;
};

function flags(value: unknown): Flag[] {
  if (!Array.isArray(value)) return [];
  const out: Flag[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const postUrl = typeof row.post_url === "string" ? row.post_url.trim() : "";
    const draft = typeof row.draft === "string" ? row.draft.trim() : "";
    if (!POST_URL.test(postUrl) || !draft) continue;
    out.push({
      post_url: postUrl,
      draft,
      why: String(row.why ?? "").trim(),
      author: String(row.author ?? "post").trim(),
      gist: String(row.gist ?? "").trim(),
    });
  }
  return out.slice(0, MAX_FLAGS);
}

function connectionId(value: unknown): number | null {
  const rows = Array.isArray(value)
    ? value
    : Array.isArray((value as { connections?: unknown })?.connections)
      ? (value as { connections: unknown[] }).connections
      : [];
  const match = (rows as Array<Record<string, unknown>>).find(
    (row) => row.slug === LINKEDIN_CONNECTION_SLUG
  );
  const id = Number(match?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// Stages each flagged post's draft as a page-activated prepare_comment run and
// links it to the notification. Nothing runs until the user opens the post in
// their own tab, and the human always clicks Post.
export default async function stageLinkedInFlags(
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> {
  const flagged = flags(ctx.extracted_data.flags);
  if (flagged.length === 0) return;
  const linkedin = connectionId(
    await client.connections.list({ connector_key: "linkedin" })
  );
  if (!linkedin) {
    throw new Error(
      `LinkedIn connection '${LINKEDIN_CONNECTION_SLUG}' not found`
    );
  }
  const source = {
    automation_id: Number(ctx.window.automation_id),
    run_id: Number(ctx.window.run_id),
  };
  for (const flag of flagged) {
    // prepare_comment drives the page LinkedIn settles on: the trailing-slash
    // form of /feed/update/<urn>. Activate on that exact URL, not the one the
    // user clicked, so the tab is already there when the draft run starts.
    const pageUrl = flag.post_url.endsWith("/")
      ? flag.post_url
      : `${flag.post_url}/`;
    const key = `linkedin-flag:${pageUrl}`;
    const staged = await client.operations.execute({
      connection_id: linkedin,
      operation_key: "prepare_comment",
      input: {
        post_url: flag.post_url,
        body: flag.draft.slice(0, 3000),
        reason: flag.why.slice(0, 500),
      },
      activation: { kind: "page_visit", urls: [pageUrl] },
      idempotency_key: key,
      automation_source: source,
    });
    await client.notifications.send({
      title: `LinkedIn: ${flag.author} · ${flag.gist}`.slice(0, 200),
      body: `${flag.why}\n\nDraft, ready in the comment box when you open the post:\n${flag.draft}`.slice(
        0,
        1000
      ),
      recipients: "admins",
      browser_url: pageUrl,
      ...(typeof staged.run_id === "number"
        ? { browser_handoff_run_id: staged.run_id }
        : {}),
      idempotency_key: key,
      automation_source: source,
    });
  }
}
