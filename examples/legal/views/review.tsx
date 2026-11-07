import { useState } from "react";
import {
  defineView,
  sql,
  tool,
  useAction,
  useQuery,
  useScope,
  type ActionResult,
} from "@lobu/views";
import {
  DataTable,
  EmptyState,
  ErrorState,
  Link,
  LoadingState,
  TruncatedNotice,
} from "@lobu/views/components";

export const view = defineView({
  key: "legal-review",
  name: "Counsel review",
  attach: [{ event: "legal-review", type: "legal-request" }],
  actions: {
    approve: { emits: "legal-decision" },
    negotiate: { emits: "legal-decision" },
    escalate: { emits: "legal-decision" },
  },
});
type Review = {
  entity_id: number;
  document_id: number;
  summary: string;
  evidence_ids: number[];
  findings: Array<{
    clause: string;
    risk: string;
    rationale: string;
    evidence_id: number;
    quote: string;
  }>;
};
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
function isReview(value: unknown): value is Review {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    isId(row.entity_id) &&
    isId(row.document_id) &&
    typeof row.summary === "string" &&
    Array.isArray(row.evidence_ids) &&
    row.evidence_ids.length > 0 &&
    row.evidence_ids.every(isId) &&
    Array.isArray(row.findings) &&
    row.findings.every(
      (finding: unknown) =>
        finding !== null &&
        typeof finding === "object" &&
        "clause" in finding &&
        typeof finding.clause === "string" &&
        "risk" in finding &&
        typeof finding.risk === "string" &&
        "rationale" in finding &&
        typeof finding.rationale === "string" &&
        "evidence_id" in finding &&
        isId(finding.evidence_id) &&
        (row.evidence_ids as number[]).includes(finding.evidence_id) &&
        "quote" in finding &&
        typeof finding.quote === "string"
    )
  );
}
export default function CounselReview() {
  const { event } = useScope();
  const read = useQuery<{
    content: Array<{ id: number; title: string | null; metadata: unknown }>;
  }>(
    event === undefined
      ? null
      : tool("read_knowledge", { content_ids: [event] })
  );
  const review = read.data?.content.find((row) => row.id === event);
  const data = isReview(review?.metadata) ? review.metadata : undefined;
  const current = useQuery<Array<{ document_id: string; review_id: string }>>(
    data
      ? sql`SELECT metadata->>'current_document_id' AS document_id, metadata->>'review_event_id' AS review_id FROM entities WHERE id = ${data.entity_id} LIMIT 1`
      : null
  );
  const approve = useAction("approve");
  const negotiate = useAction("negotiate");
  const escalate = useAction("escalate");
  const [instruction, setInstruction] = useState("");
  const [reuse, setReuse] = useState(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const submit = async (action: typeof approve) => {
    setPending(true);
    try {
      setResult(await action({ instruction, reuse }));
    } finally {
      setPending(false);
    }
  };
  const retry = async () => {
    if (!result?.retry) return;
    setPending(true);
    try {
      setResult(await result.retry());
    } finally {
      setPending(false);
    }
  };
  if (read.loading) return <LoadingState text="Loading review…" />;
  if (read.error)
    return <ErrorState message={read.error} onRetry={read.refetch} />;
  if (!review) return <EmptyState title="This review is unavailable." />;
  if (!data)
    return (
      <ErrorState message="This review lacks a supported document revision and evidence. Generate a new review before deciding." />
    );
  if (read.truncated)
    return (
      <ErrorState message="This review is too large to display completely. Open its evidence with counsel before deciding." />
    );
  const state = current.data?.[0];
  const stale =
    !state ||
    Number(state.document_id) !== data.document_id ||
    Number(state.review_id) !== event;
  const disabled =
    pending ||
    current.loading ||
    current.truncated ||
    Boolean(current.error) ||
    stale ||
    Boolean(result);
  return (
    <section
      style={{
        color: "var(--fg)",
        fontFamily: "var(--font, system-ui)",
        padding: 16,
      }}
    >
      <h2 style={{ marginTop: 0 }}>{review.title ?? "Counsel review"}</h2>
      <p>{data.summary}</p>
      <p>
        Document revision <strong>#{data.document_id}</strong>.{" "}
        <Link href={`events/${data.evidence_ids[0]}`}>
          Open source evidence
        </Link>
      </p>
      <DataTable
        rows={data.findings}
        keyOf={(_, index) => index}
        columns={[
          {
            key: "clause",
            header: "Clause",
            render: (row) => (
              <span style={{ display: "block", minWidth: 100 }}>
                {row.clause}
              </span>
            ),
          },
          {
            key: "risk",
            header: "Risk",
            render: (row) => (
              <span style={{ whiteSpace: "nowrap" }}>{row.risk}</span>
            ),
          },
          {
            key: "rationale",
            header: "Rationale",
            render: (row) => (
              <span style={{ display: "block", minWidth: 180 }}>
                {row.rationale}
              </span>
            ),
          },
          {
            key: "quote",
            header: "Evidence",
            render: (row) => (
              <span style={{ display: "block", minWidth: 220 }}>
                <q>{row.quote}</q>{" "}
                <Link href={`events/${row.evidence_id}`}>
                  Source #{row.evidence_id}
                </Link>
              </span>
            ),
          },
        ]}
        emptyText="No clause findings were returned. Counsel should still review the source."
      />
      {current.error && (
        <ErrorState message={current.error} onRetry={current.refetch} />
      )}
      {current.truncated && (
        <TruncatedNotice shown={current.data?.length ?? 0} />
      )}
      {!current.loading && stale && !current.error && (
        <p role="status">
          This review is no longer current. Open the request's latest review
          before deciding.
        </p>
      )}
      <fieldset
        disabled={disabled}
        style={{ border: "1px solid var(--border)", marginTop: 16 }}
      >
        <legend>Counsel decision</legend>
        <label style={{ display: "block" }}>
          Instruction for this matter
          <textarea
            maxLength={1500}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            style={{
              display: "block",
              boxSizing: "border-box",
              width: "100%",
              font: "inherit",
              color: "inherit",
              background: "transparent",
              border: "1px solid var(--border)",
            }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={reuse}
            onChange={(e) => setReuse(e.target.checked)}
          />{" "}
          Propose this instruction as a draft Q&A for review
        </label>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}
        >
          <button type="button" onClick={() => submit(approve)}>
            Approve for signature
          </button>
          <button type="button" onClick={() => submit(negotiate)}>
            Negotiate
          </button>
          <button type="button" onClick={() => submit(escalate)}>
            Escalate
          </button>
        </div>
      </fieldset>
      {pending && <p role="status">Recording decision…</p>}
      {result?.ok && (
        <p role="status">
          Decision recorded. The decision Automation will update this matter.
          Signature and execution remain separate steps.
        </p>
      )}
      {result && !result.ok && (
        <ErrorState
          message={result.error ?? "The decision could not be acknowledged."}
          onRetry={pending ? undefined : retry}
        />
      )}
    </section>
  );
}
