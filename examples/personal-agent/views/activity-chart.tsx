import { defineView, sql, useQuery, useScope } from "@lobu/views";

export const view = defineView({
  key: "activity-chart",
  attach: [{ event_kind: "system_activity_snapshot" }],
});

export default function ActivityChart() {
  const { event } = useScope();
  const read = useQuery<
    {
      title: string | null;
      metadata: { rows: { label: string; value: number }[] };
    }[]
  >(
    event === undefined
      ? null
      : sql`SELECT title, metadata FROM events WHERE id = ${event}`
  );
  if (read.error) return <p role="alert">{read.error}</p>;
  if (read.loading && !read.data) return <p role="status">Loading activity…</p>;
  const snapshot = read.data?.[0];
  if (!snapshot)
    return <p>This snapshot is no longer current. Reopen the event.</p>;
  const rows = snapshot.metadata.rows ?? [];
  const maximum = Math.max(1, ...rows.map((row) => row.value));
  return (
    <section style={{ color: "var(--fg)", fontFamily: "inherit", padding: 16 }}>
      <h2>{snapshot.title ?? "Activity snapshot"}</h2>
      <table
        style={{ width: "100%", textAlign: "left", borderSpacing: "0 8px" }}
      >
        <thead>
          <tr>
            <th scope="col">Event kind</th>
            <th scope="col">Events</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label}>
              <th scope="row">{row.label}</th>
              <td>
                <span>{row.value}</span>
                <div
                  aria-hidden="true"
                  style={{
                    height: 6,
                    borderRadius: 3,
                    background: "var(--fg, currentColor)",
                    opacity: 0.5,
                    width: `${(Math.max(0, row.value) / maximum) * 100}%`,
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p>No activity in this snapshot.</p>}
    </section>
  );
}
