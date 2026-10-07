import {
  defineView,
  sql,
  useAction,
  useQuery,
  useScope,
  type ActionResult,
} from "@lobu/views";
import { useState } from "react";

export const view = defineView({
  key: "poll-ballot",
  attach: [{ event_kind: "poll_opened", type: "poll" }],
  actions: { vote: { emits: "poll_vote_cast" } },
});

interface Ballot {
  question: string;
  options: string[];
  status: "open" | "closed";
  quorum: number;
  closes_at: string;
  results: { option: string; count: number }[];
  response_count: number;
}

export default function PollBallot() {
  const { event } = useScope();
  const read = useQuery<{ metadata: Ballot }[]>(
    event === undefined
      ? null
      : sql`SELECT metadata FROM events WHERE id = ${event}`
  );
  const vote = useAction("vote");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const ballot = read.data?.[0]?.metadata;

  async function submit(action: () => Promise<ActionResult>) {
    if (pending) return;
    setPending(true);
    try {
      setResult(await action());
    } finally {
      setPending(false);
    }
  }

  if (read.error) return <p role="alert">{read.error}</p>;
  if (read.loading && !ballot) return <p role="status">Loading ballot…</p>;
  if (!ballot)
    return (
      <p>This ballot has changed. Reopen the event to see its current state.</p>
    );

  const closed =
    ballot.status === "closed" || Date.parse(ballot.closes_at) <= Date.now();
  return (
    <section
      aria-label="Poll"
      style={{ color: "var(--fg)", fontFamily: "inherit", padding: 16 }}
    >
      <h2>{ballot.question}</h2>
      <p>
        {ballot.response_count} participants · Quorum {ballot.quorum}
      </p>
      <p>
        {closed ? (
          "Voting is closed."
        ) : (
          <>
            Open until{" "}
            <time dateTime={ballot.closes_at}>
              {new Date(ballot.closes_at).toLocaleString()}
            </time>
          </>
        )}
      </p>
      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 8 }}>
        {ballot.options.map((option) => (
          <li key={option}>
            <button
              type="button"
              disabled={closed || pending || result?.ok === true}
              onClick={() => void submit(() => vote({ choice: option }))}
              style={{
                width: "100%",
                textAlign: "left",
                padding: 12,
                borderRadius: 8,
                border: "1px solid var(--border, currentColor)",
                color: "inherit",
                background: "transparent",
                cursor: closed || pending ? "default" : "pointer",
              }}
            >
              {option} ·{" "}
              {ballot.results.find((entry) => entry.option === option)?.count ??
                0}
            </button>
          </li>
        ))}
      </ul>
      <p role="status" aria-live="polite">
        {pending
          ? "Submitting vote…"
          : result?.ok
            ? "Vote received. Results will update when it is counted."
            : ""}
      </p>
      {result?.error && (
        <div role="alert">
          <p>{result.error}</p>
          {result.retry && (
            <button
              type="button"
              disabled={pending}
              onClick={() => void submit(result.retry!)}
            >
              Retry this vote
            </button>
          )}
        </div>
      )}
    </section>
  );
}
