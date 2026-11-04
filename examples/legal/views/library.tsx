import { defineView, sql, useParams, useQuery, useScope } from "@lobu/views";
import {
  DataTable,
  FilterBar,
  Link,
  SearchField,
  TruncatedNotice,
} from "@lobu/views/components";

export const view = defineView({
  key: "legal-library",
  name: "Legal library",
  attach: [
    { workspace: true },
    { record: "legal-folder" },
    { record: "knowledge-bank" },
  ],
  params: {
    kind: { type: "string", default: "all" },
    search: { type: "string", default: "" },
    page: { type: "number", default: 1 },
  },
});
type Row = {
  id: number;
  name: string;
  slug: string;
  entity_type: string;
  parent_name: string | null;
  status: string | null;
};
const kinds: Record<string, string> = {
  all: "All records",
  "legal-folder": "Folders",
  "knowledge-bank": "Knowledge Banks",
  "legal-document": "Documents",
  "legal-guidance": "Q&A",
  "playbook-position": "Playbook",
  person: "People",
  counterparty: "Companies",
  contract: "Agreements",
  "legal-request": "Requests",
  "legal-obligation": "Obligations",
  "legal-suggestion": "Suggestions",
  "legal-ops-snapshot": "Operations",
  "legal-team": "Teams",
};
export default function LegalLibrary() {
  const [params, setParams] = useParams();
  const scope = useScope();
  const scoped = scope.entity !== undefined;
  const parent = typeof scope.entity === "number" ? scope.entity : null;
  const kind = Object.hasOwn(kinds, String(params.kind))
    ? String(params.kind)
    : "all";
  const requestedPage = Math.floor(Number(params.page));
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;
  const search = String(params.search ?? "");
  const read = useQuery<
    Row[]
  >(sql`SELECT e.id, e.name, e.slug, e.entity_type, p.name AS parent_name, e.metadata->>'status' AS status
    FROM entities e LEFT JOIN entities p ON p.id = e.parent_id
    WHERE e.entity_type IN ('legal-folder','knowledge-bank','legal-document','legal-guidance','playbook-position','person','counterparty','contract','legal-request','legal-obligation','legal-suggestion','legal-ops-snapshot','legal-team')
      AND (${!scoped} OR e.parent_id = ${parent} OR (p.entity_type = ${scope.type ?? ""} AND p.slug = ${String(scope.entity ?? "")}))
      AND (${kind} = 'all' OR e.entity_type = ${kind})
      AND starts_with(lower(e.name), lower(${search}))
    ORDER BY e.name, e.id LIMIT 50 OFFSET ${(page - 1) * 50}`);
  return (
    <section
      style={{
        color: "var(--fg)",
        fontFamily: "var(--font, system-ui)",
        padding: 16,
      }}
    >
      <h2 style={{ marginTop: 0 }}>Legal library</h2>
      <p style={{ color: "var(--muted)" }}>
        {scoped
          ? "Records in this folder or Knowledge Bank."
          : "Explore matters, people and source documents. Only approved Q&A and playbook positions may be reused."}
      </p>
      <FilterBar>
        <label>
          Show{" "}
          <select
            value={kind}
            onChange={(e) => setParams({ kind: e.target.value, page: 1 })}
          >
            {Object.entries(kinds).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <SearchField
          label="Name starts with"
          value={search}
          onChange={(value) => setParams({ search: value, page: 1 })}
        />
      </FilterBar>
      <DataTable
        rows={read.data ?? []}
        keyOf={(row) => row.id}
        loading={read.loading}
        error={read.error}
        onRetry={read.refetch}
        columns={[
          {
            key: "name",
            header: "Record",
            render: (row) => (
              <span style={{ display: "block", minWidth: 180 }}>
                <Link href={`${row.entity_type}/${row.slug}`}>{row.name}</Link>
              </span>
            ),
          },
          {
            key: "entity_type",
            header: "Type",
            render: (row) => (
              <span style={{ whiteSpace: "nowrap" }}>
                {kinds[row.entity_type] ?? row.entity_type}
              </span>
            ),
          },
          {
            key: "parent_name",
            header: "Folder / Knowledge Bank",
            render: (row) => (
              <span style={{ display: "block", minWidth: 180 }}>
                {row.parent_name ?? "—"}
              </span>
            ),
          },
          {
            key: "status",
            header: "Status",
            render: (row) => (
              <span style={{ whiteSpace: "nowrap" }}>
                {row.status === "approved" &&
                row.entity_type === "legal-request"
                  ? "Approved for signature"
                  : (row.status?.replaceAll("_", " ") ?? "—")}
              </span>
            ),
          },
        ]}
        emptyText="No records match these filters."
        pagination={{
          page,
          pageSize: 50,
          onPage: (value) => setParams({ page: value }),
        }}
      />
      {read.truncated && <TruncatedNotice shown={read.data?.length ?? 0} />}
    </section>
  );
}
