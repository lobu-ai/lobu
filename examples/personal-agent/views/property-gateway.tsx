import { useState } from "react";
import { defineView, tool, useQuery } from "@lobu/views";
import {
  DataTable,
  EntityListPage,
  FilterBar,
  Link,
  SearchField,
  SelectField,
  TruncatedNotice,
} from "@lobu/views/components";

export const view = defineView({
  key: "property-gateway",
  name: "Properties",
  description: "Saved properties and direct access to source listings.",
  attach: [{ workspace: true }],
});

type Property = {
  id: number;
  slug: string;
  name: string;
  metadata: {
    stage?: string;
    category?: string;
    last_seen?: string;
    listings?: { portal?: string; url?: string; seen?: string }[];
  };
};
type Page = {
  entities: Property[];
  metadata: { total_count: number; has_more: boolean };
};
const SIZE = 25;
const STAGES = [
  "new",
  "shortlisted",
  "visited",
  "offered",
  "owned",
  "sold",
  "skipped",
];
const date = (value?: string) =>
  value && /^\d{4}-\d{2}-\d{2}/.test(value)
    ? value.slice(0, 10)
    : "Not recorded";
// Saved URLs are data, not permission to open an arbitrary scheme or host.
function listingUrl(value?: string) {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" &&
      [
        "www.sahibinden.com",
        "sahibinden.com",
        "www.allsop.co.uk",
        "allsop.co.uk",
      ].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export default function PropertyGateway() {
  const [search, setSearch] = useState("");
  const [stage, setStage] = useState("");
  const [page, setPage] = useState(1);
  const read = useQuery<Page>(
    tool("manage_entity", {
      action: "list",
      entity_type: "asset",
      search,
      limit: SIZE,
      offset: (page - 1) * SIZE,
      sort_by: "name",
      sort_order: "asc",
      filters: [
        { field: "asset_class", op: "eq", value: "real_estate" },
        ...(stage ? [{ field: "stage", op: "eq", value: stage }] : []),
      ],
    })
  );
  return (
    <EntityListPage
      title="Properties"
      loading={read.loading}
      error={read.error}
      onRetry={read.refetch}
      actions={<Link href="asset/-/views/asset-map">Open asset map</Link>}
      controls={
        <FilterBar>
          <SearchField
            label="Search saved properties"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <SelectField
            label="Stage"
            value={stage}
            options={[
              ...STAGES.map((value) => ({
                value,
                label: value.replaceAll("_", " "),
              })),
            ]}
            onChange={(value) => {
              setStage(value);
              setPage(1);
            }}
          />
        </FilterBar>
      }
    >
      <p>
        <Link href="https://www.allsop.co.uk/property-search">
          Browse Allsop properties
        </Link>
      </p>
      <p>
        Saved observations are historical. Open a source listing to check its
        current price and availability. Allsop search opens the provider
        website; its inventory has not been imported here.
      </p>
      <DataTable<Property>
        rows={read.data?.entities ?? []}
        keyOf={(row) => row.id}
        loading={read.loading}
        error={read.error}
        onRetry={read.refetch}
        emptyText="No saved properties match these filters."
        columns={[
          {
            key: "name",
            header: "Property",
            render: (row) => (
              <Link href={`asset/${encodeURIComponent(row.slug)}`}>
                {row.name}
              </Link>
            ),
          },
          {
            key: "category",
            header: "Type",
            render: (row) => row.metadata.category ?? "Not recorded",
          },
          {
            key: "stage",
            header: "Stage",
            render: (row) => row.metadata.stage ?? "Not recorded",
          },
          {
            key: "observed",
            header: "Last saved observation",
            render: (row) => date(row.metadata.last_seen),
          },
          {
            key: "source",
            header: "Source listing",
            render: (row) => (
              <>
                {(row.metadata.listings ?? []).map((listing, index) => {
                  const url = listingUrl(listing.url);
                  return url ? (
                    <div key={`${url}-${index}`}>
                      <Link href={url}>{listing.portal ?? "Open listing"}</Link>{" "}
                      <span>({date(listing.seen)})</span>
                    </div>
                  ) : null;
                })}
              </>
            ),
          },
        ]}
        pagination={{
          page,
          pageSize: SIZE,
          total: read.data?.metadata.total_count,
          onPage: setPage,
        }}
      />
      {read.truncated && <TruncatedNotice />}
    </EntityListPage>
  );
}
