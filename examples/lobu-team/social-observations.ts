import type {
  Draft,
  EvidencePolicy,
  Receipt,
  SourceReader,
} from "./external-social-evidence";

export function findingHasReceipt(f: Draft, policy: EvidencePolicy) {
  const m = f?.metadata;
  return (
    m?.workflow === policy.workflow &&
    policy.platforms.includes(m.platform) &&
    m.source_url === f.source_url &&
    m.review_status === "pending" &&
    Array.isArray(m.read_receipts) &&
    m.read_receipts.length > 0
  );
}

async function findSourcePosts(
  read: SourceReader,
  platform: string,
  receipts: Receipt[],
  sourceUrl: string | undefined,
  originId: string
) {
  const posts = (
    await Promise.all(receipts.map((r) => read(platform, r)))
  ).flatMap((page) => page.posts);
  return posts.filter(
    (p) => p.source_url === sourceUrl && p.origin_id === originId
  );
}

function quoteInBody(body: string, value: unknown) {
  const quote = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    quote.length > 0 &&
    quote.length <= 200 &&
    body.replace(/\s+/g, " ").includes(quote)
  );
}

export async function verifyFindings(
  findings: Draft[],
  policy: EvidencePolicy,
  read: SourceReader
) {
  const seen = new Set<string>();
  for (const f of findings) {
    if (!findingHasReceipt(f, policy))
      throw new Error(
        "Finding lacks its exact source receipt or uses an out-of-scope platform"
      );
    const fm = f.metadata;
    const posts = await findSourcePosts(
      read,
      fm.platform,
      fm.read_receipts,
      f.source_url,
      fm.origin_id
    );
    if (!posts.some((post) => quoteInBody(post.text, fm.evidence_quote)))
      throw new Error(
        "Finding excerpt is absent from the exact source receipt"
      );
    const key = `${fm.platform}:${fm.origin_id}`;
    if (seen.has(key)) throw new Error("Duplicate finding");
    seen.add(key);
  }
}

function canonicalProfile(url: string, required = true) {
  // This function is embedded in MCP's V8 sandbox, which has no URL global.
  // Accept only ordinary HTTP(S) profile URLs, without credentials or ports.
  const parts =
    typeof url === "string"
      ? /^(https?):\/\/([a-z0-9.-]+)(\/[^?#]*)?(?:[?#].*)?$/i.exec(url)
      : null;
  if (!parts) {
    if (required) throw new Error("Invalid graph profile URL");
    return null;
  }
  return `${parts[1]}://${parts[2]!.replace(/^www\./i, "")}${(parts[3] || "/").replace(/\/posts\/?$/, "").replace(/\/$/, "")}`.toLowerCase();
}

export async function verifyGraphCandidates(
  graph: any[],
  policy: EvidencePolicy,
  read: SourceReader
) {
  if (!Array.isArray(graph) || graph.length > 100)
    throw new Error("Graph candidates must be a bounded array");
  const graphSeen = new Set<string>();
  for (const g of graph) {
    if (!g || typeof g !== "object")
      throw new Error("Invalid graph observation");
    g.evidence_verified = false;
    if (
      g.workspace !== policy.workspace ||
      !policy.platforms.includes(g.platform) ||
      typeof g.connection !== "string" ||
      !g.connection ||
      typeof g.summary !== "string" ||
      !g.summary.trim() ||
      g.summary.length > 280 ||
      !Array.isArray(g.read_receipts) ||
      !g.read_receipts.length ||
      !Array.isArray(g.claims) ||
      g.claims.length > 20
    )
      throw new Error("Invalid graph observation");
    const posts = await findSourcePosts(
      read,
      g.platform,
      g.read_receipts,
      g.source_url,
      g.origin_id
    );
    const authored = posts.filter(
      (p) =>
        p.author_url &&
        g.subject?.profile_url &&
        canonicalProfile(p.author_url) ===
          canonicalProfile(g.subject.profile_url)
    );
    if (!authored.length)
      throw new Error("Graph subject lacks a matching author profile receipt");
    const key = `${g.workspace}:${g.connection}:${g.platform}:${g.origin_id}`;
    if (graphSeen.has(key)) throw new Error("Duplicate graph observation");
    graphSeen.add(key);
    for (const claim of g.claims) {
      if (!claim || typeof claim !== "object")
        throw new Error("Invalid graph observation");
      canonicalProfile(claim.target?.profile_url);
    }
    // Expansion can reveal both text and links. All claims must be backed by
    // one retained snapshot, rather than combining different post versions.
    const p = authored.find((post) =>
      g.claims.every(
        (claim: any) =>
          quoteInBody(post.text, claim.evidence_quote) &&
          post.mentioned_profiles?.some(
            // Unrelated body links may use mailto: or other non-profile schemes.
            (url) =>
              canonicalProfile(url, false) ===
              canonicalProfile(claim.target.profile_url)
          )
      )
    );
    if (!p)
      throw new Error(
        "Graph relationship lacks exact text and target-profile evidence"
      );
    g.subject.profile_url = canonicalProfile(g.subject.profile_url);
    g.source_time = p.occurred_at;
    g.evidence_verified = true;
  }
  return graph.length;
}
