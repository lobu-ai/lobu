# Access resources and visibility envelopes

> **Status:** Proposed consolidation, August 2026.
>
> **Shipped foundation:** `$member` identity resolution, `$resource` entities,
> protected `member_of` edges, `AuthzScope`, connection ACL freshness, and the
> Slack/GitHub resource gates.
>
> **Not shipped by this document:** generic entity scoping, project-defined ACL
> sources, access-management SDK methods, resource-bound action approvals, and
> automatic visibility propagation to every derived artifact.
>
> This document is the current design direction for extending the shipped
> connector-resource ACL model to generic Lobu data. The older
> [`authz-acl-permission-program`](../plans/authz-acl-permission-program.md) and
> [`connector-authz-model`](../plans/connector-authz-model.md) remain useful design
> history, but their proposed `can_read`/`deny_read` vocabulary and broader policy
> machinery do not describe the smallest extension of the code that exists today.

## Decision

Lobu has one read-authorization primitive:

```text
principal ──member_of──> access resource
```

A protected object carries a **visibility envelope**: the set of access resources
the caller must belong to. Empty means normal workspace visibility. Multiple
resources mean **all are required**.

```text
Invoice FTR-42
  requires: [Legal Entity UK]

Stock movement STK-88
  requires: [Legal Entity UK, Warehouse A]

Workspace product catalogue
  requires: []
```

The model deliberately separates three questions:

```text
CONTROL PLANE
owner / admin / member
Who may configure the Lobu workspace?

VISIBILITY PLANE
principal ──member_of──> access resource
Which data may this principal see?

ACTION PLANE
operation policy + approval + source authorization
Which command may this principal execute?
```

Do not make one global role system answer all three.

## Why this is the consolidation point

The shipped source ACL implementation already normalizes Slack channels and
GitHub repositories into:

```text
resource × effective audience
```

The server materializes each resource as an entity, resolves people through
`entity_identities`, writes protected direct `member_of` edges, reconciles
departures, and marks the source ACL state fresh. The read gate then intersects
the requesting user with the resource linked to the content.

Generic ERP and project data need the same thing, not a second authorization
engine.

### Reused primitives

| Existing primitive | Reuse |
| --- | --- |
| `$member` entity | Human principal |
| `entity_identities` | Trusted identity resolution |
| `$resource` entity | Connector-owned access boundary |
| Ordinary domain entity | Project-owned access boundary when explicitly declared |
| `member_of` | Effective principal membership in an access boundary |
| authorization-purpose relationship protection | Prevent callers from minting access |
| `AuthzScope` | Carries the requesting user and agent boundary |
| `authz_source_acl_state` | Freshness and fail-closed revocation for source-owned ACLs |
| SQL scoping compiler | One place to apply entity/event visibility to SQL readers |
| Automation provenance | Evidence used to propagate visibility to outputs |

### Current implementation anchors

- `packages/connector-sdk/src/acl-source.ts` — the current `AclSourceDef`,
  `AccessResource`, and `AccessMember` contracts;
- `packages/server/src/authz/access-graph.ts` — identity resolution, resource
  materialization, protected membership reconciliation, and freshness updates;
- `packages/server/src/authz/resource-visibility.ts` — the current generic
  connector-event resource gate;
- `packages/server/src/authz/sources.ts` — the current static Slack/GitHub ACL
  source registry that project connectors need to replace;
- `packages/server/src/utils/relationship-validation.ts` — authorization-purpose
  relationship protection and privileged ACL writes;
- `packages/server/src/utils/execute-data-sources.ts` — the shared SQL scoping seam
  that must enforce generic visibility without per-caller filters.

### Things this design does not add

- no `accountant`, `warehouse_manager`, or other global business roles;
- no `can_read`, `deny_read`, `can_write`, `approver_of`, or role-bundle graph;
- no authorization inheritance through `parent_id`;
- no arbitrary ABAC or customer-authored policy language;
- no external OpenFGA, SpiceDB, Cedar, or OPA dependency;
- no generic field-level ACL.

## Access resources

An access resource is an entity whose audience is meaningful for authorization.

Two forms are supported conceptually:

1. **Connector resource:** the existing platform `$resource` type, identity-keyed
   by the connector (`slack_channel_id`, `github_repo_full_name`, and so on).
2. **Project resource:** an ordinary domain type explicitly declared as an
   access resource, such as `legal-entity`, `warehouse`, `plant`, `project`, or
   `payroll-scope`.

Project resources avoid shadow copies such as a `legal-entity` entity plus a
second `$resource` entity for the same thing.

Proposed authoring shape:

```ts
const legalEntity = defineEntityType({
  key: "legal-entity",
  name: "Legal Entity",
  accessResource: true,
  properties: {
    code: field("Code"),
    country: field("Country"),
  },
});

const warehouse = defineEntityType({
  key: "warehouse",
  name: "Warehouse",
  accessResource: true,
  properties: {
    code: field("Code"),
    title: field("Title"),
  },
});
```

`accessResource: true` does not grant anyone access. It only permits the type's
entities to be targets of the trusted access-management surface and of declared
visibility rules.

### One audience authority per resource in V1

Every access resource has one audience authority:

- `manual` for a project/admin-managed resource; or
- one connector ACL source for a source-managed resource.

The authority is server-controlled. A source-managed resource cannot also receive
ad-hoc manual grants in V1; the source compiler must include any overlay audience.
This avoids two reconcilers deleting each other's grants and avoids an edge-claim
subsystem before a customer requires one.

Protected `member_of` edges record their authority in system metadata. The gate
accepts a manual edge immediately and accepts a connector-owned edge only while
that authority's ACL state is fresh. This generalizes the shipped event gate,
which currently obtains the authority from `event.connection_id`, to generic
entities that have no source connection column of their own.

### Access-resource lifecycle

Access resources are security objects even when they are ordinary domain
entities. A referenced resource cannot be silently deleted, merged, unmerged, or
retargeted:

- source-owned lifecycle changes come from the owning ACL source;
- manual-resource changes use the trusted access surface;
- deletion/archive blocks while protected rows still require the resource;
- merge or identity reassignment requires an explicit migration of both
  membership and every dependent visibility reference;
- a missing resource fails closed rather than widening its dependants.

## Effective audiences, not runtime policy graphs

The runtime membership graph should stay flat:

```text
Alice ──member_of──> Legal Entity UK
Bob   ──member_of──> Legal Entity UK
```

A source connector, IdP integration, project reconciler, or admin UI may let the
operator author access through groups, but it compiles those groups to direct
effective member-to-resource edges.

This avoids recursive group traversal on every read and makes revocation
reconciliation explicit.

### OR

To give Finance **or** External Auditors access, both audiences compile into the
same resource:

```text
Finance members          ──member_of──> Legal Entity UK
External Auditor members ──member_of──> Legal Entity UK
```

If the object policy itself is `Resource A OR Resource B`, do not attach both to
the envelope: multiple envelope entries mean AND. The policy compiler creates one
synthetic access resource whose effective audience is the union and assigns that
resource one authority.

### AND

To require legal-entity and warehouse access, the object carries both resources:

```text
requires: [Legal Entity UK, Warehouse A]
```

### Explicit deny

A deny is compiled by excluding the denied member from the effective audience.
There is no persistent `deny_read` relation in the first version.

If a source policy cannot be compiled safely to an effective audience, Lobu must
use per-user live retrieval or fail closed. It must not approximate the policy.

## Declaring an entity's visibility envelope

For stored generic entities, the smallest implementation derives the envelope
from existing entity-reference fields. It does not add a hierarchy, a second
relationship graph, or a materialized column in the first slice.

Proposed authoring shape:

```ts
const invoice = defineEntityType({
  key: "invoice",
  name: "Invoice",

  properties: {
    legal_entity_id: ref("legal-entity", "Legal Entity"),
    document_no: field("Document No"),
    status: field("Status"),
  },

  visibility: {
    require: [{ field: "legal_entity_id" }],
  },
});

const stockMovement = defineEntityType({
  key: "stock-movement",
  name: "Stock Movement",

  properties: {
    legal_entity_id: ref("legal-entity", "Legal Entity"),
    warehouse_id: ref("warehouse", "Warehouse"),
    product_id: ref("product", "Product"),
    quantity: field(Type.Number(), "Quantity"),
  },

  visibility: {
    require: [
      { field: "legal_entity_id" },
      { field: "warehouse_id" },
    ],
  },
});
```

The CLI lowers the declaration into a security-owned schema extension, following
the existing `resolutionPolicy` pattern:

```json
{
  "x-lobu-visibility": {
    "requireFields": ["legal_entity_id", "warehouse_id"]
  }
}
```

The exact public spelling is proposed. The semantic contract is the important
part.

### Validation

`lobu validate` and the server must reject a visibility rule when:

- the named field does not exist;
- the field is not an entity reference;
- the target type is not an access-resource type;
- a required field is optional;
- a field points to a cross-organization or public-catalog entity;
- a scoped existing row is missing or has an invalid resource reference.

A missing or invalid requirement fails closed. It never falls back to workspace
visibility.

### No materialization in V1

The first implementation should resolve the declared resource fields in the
shared SQL visibility compiler. It should not add `access_resource_ids` to every
table until measurements show that compile-on-read is too expensive.

The compiler resolves the current member once, computes that member's direct
resource IDs once, and reuses the set for the page/query.

A future materialized label is an optimization, not a different model.

## The read rule

Conceptually:

```text
visible(entity, caller) =
  entity belongs to caller's workspace
  AND (
    entity type has no visibility requirements
    OR every required resource id is in caller's effective resource set
  )
```

Pseudo-SQL:

```sql
WITH caller_resources AS (
  SELECT r.to_entity_id AS resource_id
  FROM entity_relationships r
  JOIN entity_relationship_types rt
    ON rt.id = r.relationship_type_id
  WHERE r.organization_id = :organization_id
    AND r.from_entity_id = :member_entity_id
    AND rt.slug = 'member_of'
    AND r.deleted_at IS NULL
)
SELECT e.*
FROM entities e
JOIN entity_types et ON et.id = e.entity_type_id
WHERE e.organization_id = :organization_id
  AND (
    et.metadata_schema->'x-lobu-visibility' IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(
        et.metadata_schema->'x-lobu-visibility'->'requireFields'
      ) AS required(field_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM caller_resources cr
        WHERE cr.resource_id = CASE
          WHEN (e.metadata->>required.field_name) ~ '^[1-9][0-9]{0,17}$'
            OR (
              (e.metadata->>required.field_name) ~ '^[1-9][0-9]{18}$'
              AND (e.metadata->>required.field_name) <= '9223372036854775807'
            )
          THEN (e.metadata->>required.field_name)::bigint
          ELSE NULL
        END
      )
    )
  );
```

The positive membership check is deliberately nested inside the anti-join. A
missing, null, zero, negative, non-numeric, or out-of-range reference—including
9223372036854775808, one above PostgreSQL's signed-bigint maximum—produces no
matching caller resource, so the outer query hides the row. Production SQL should
avoid repeated JSON extraction, but the fail-closed semantics stay this small. Its
`caller_resources` CTE
must include only protected membership edges whose authority is `manual` or whose
connector ACL state is fresh. A stale connector authority therefore removes the
resource from the caller's effective set without deleting or trusting stale edges.

### Control-plane admins

`owner` and `admin` remain workspace administration roles. They do not receive a
hidden data-plane bypass.

A manually created access resource may initially seed owners/admins into its
audience for usability. That is explicit data, visible in access explanations,
not an invisible superuser bypass. Source-owned resources continue to mirror the
source audience.

A later break-glass flow may grant short-lived, audited membership.

## One gate, every read surface

Securing only an entity detail page is a data leak. The same visibility
predicate must bind every surface that can reveal the object or its fields:

- `entities.list`, `entities.get`, and entity search;
- `search_memory` entity results;
- `resolve_path`, children, siblings, counts, and reference lookups;
- relationship lists and graph expansion;
- `query_sql` entity and entity-type CTEs;
- Automation SQL sources and reaction `client.query`;
- view-template data sources and derived entity views;
- metrics and aggregates;
- exports and attachments;
- action runs, approval events, and notifications that reveal target data.

Relationship rows are readable only when both endpoints are readable. Counts,
pagination, sorting, and aggregation happen after the visibility predicate, not
after application-memory filtering.

### Source-backed and external rows

A direct source-feed or connection-pushdown row may have no stored Lobu entity from
which to derive `x-lobu-visibility`. It is safe only when one of these holds:

1. the query executes with the requesting user's source credential and the source
   enforces visibility; or
2. the trusted connector returns normalized access-resource keys for every row,
   and Lobu applies the same envelope gate before returning or aggregating it.

A shared service-account query that returns neither source-enforced results nor
trusted resource labels is owner-only/fail-closed. Caller-authored SQL cannot
declare its own labels; otherwise it could relabel restricted source rows as
workspace-visible.

## Events and connector content

Events already carry linked entity IDs, including connector `$resource` IDs.
Treat those resource IDs as the event's visibility envelope.

The consolidated rule is:

```text
event visible iff caller belongs to every access resource linked to the event
```

The shipped one-resource Slack/GitHub cases remain unchanged. If an event links
to several access resources, the consolidated gate uses AND semantics rather
than "member of any linked resource."

Connection-owned ACL freshness remains part of the gate:

```text
never graphed  → existing compatibility path
fresh/full     → enforce resource audience
stale/failed   → fail closed
```

For shipped events, `event.connection_id` identifies the ACL authority. For a
generic entity or a derived artifact, the protected `member_of` edge's authority
metadata identifies it instead. The visibility envelope therefore remains a set
of resource IDs; freshness is checked when the caller tries to satisfy each
resource requirement.

Project-managed resources written directly in Lobu are immediately
authoritative and do not need a connector freshness record.

When custom connectors can register access sources, their resources use the same
freshness and generation fence as the existing Slack/GitHub graph.

## Derived artifacts and Automations

Visibility is monotonic:

```text
output envelope = union of every input envelope
```

Example:

```text
UK invoice           → [Legal Entity UK]
Warehouse A movement → [Legal Entity UK, Warehouse A]
Payroll note         → [Payroll UK]

summary of all three → [Legal Entity UK, Warehouse A, Payroll UK]
```

The runtime, not the model, attaches the resulting envelope.

Detailed provenance remains necessary for audit, explanations, and verifying
that the input set was complete. The envelope is the fast enforcement summary
of that provenance.

### Phasing

For fixed Automation sources, Lobu already knows the input content IDs and can
collect their resource envelopes deterministically.

For an unrestricted agent that performs arbitrary SDK/tool reads, every reader
must return or accumulate its envelope into the run context. Until that
information-flow tracking is complete, do not publish workspace-visible outputs
that mix restricted scopes.

### Aggregates

A query-time aggregate should filter its source rows for the caller before
aggregation.

A cached aggregate built from several resources inherits their union. This is
safe but may be intentionally restrictive; it must not be relabeled
workspace-wide.

## Agents and Automations as principals

Humans already resolve to `$member` entities.

To grant autonomous actors access without inventing a new ACL system, agents and
Automations become platform-owned principal entities with stable identity claims:

```text
$agent      ──member_of──> access resource
$automation ──member_of──> access resource
```

Attended execution:

```text
effective access = human access ∩ agent boundary
```

Autonomous execution:

```text
effective access = Automation principal access
```

A headless actor with no explicit resource memberships sees no restricted data.

This is an additive phase. Human generic-entity scoping does not need to wait for
it, but unattended ERP Automations over restricted data do.

## Actions are not data ACLs

Seeing an invoice does not automatically authorize posting it.

A resource-bound action follows:

```text
1. Resolve the target entity or declared resource.
2. Enforce target visibility.
3. Apply existing operation policy.
4. Request approval when required.
5. Revalidate source state and permissions.
6. Execute through the authoritative ERP/domain transaction.
7. Copy the target envelope onto the run, approval, notification, and result.
```

Proposed action binding:

```ts
post_invoice: {
  kind: "write",

  authorization: {
    entityInput: "invoice_id",
  },

  inputSchema: { /* ... */ },
}
```

This does not add `operator_of` or `approver_of` graph relations. Operation
policy and approval answer "may execute"; the resource envelope answers "may
see"; deterministic domain code answers "is the command valid."

A shared source service account still needs delegated identity, a trusted actor
assertion, or source-side approval. A Lobu visibility result is not a substitute
for source authorization.

## Connector SDK

The connector SDK already defines `AclSourceDef`, `AccessResource`, and
`AccessMember`. The missing productization is dynamic registration and a normal
sync hook for project connectors rather than a static core registry.

Proposed shape:

```ts
export default defineConnector({
  key: "prodma",

  accessSources: {
    legalEntities: {
      resource: {
        entityType: "legal-entity",
        identityNamespace: "prodma_legal_entity_id",
      },
      memberIdentities: [
        { namespace: "prodma_user_id", primary: true },
        { namespace: "email" },
      ],
    },

    warehouses: {
      resource: {
        entityType: "warehouse",
        identityNamespace: "prodma_warehouse_id",
      },
      memberIdentities: [
        { namespace: "prodma_user_id", primary: true },
      ],
    },
  },

  async syncAccess(ctx, sourceKey) {
    if (sourceKey === "legalEntities") {
      return [
        {
          key: "UK",
          name: "Legal Entity UK",
          members: [
            {
              key: "user:17",
              name: "Alice",
              identities: [
                { namespace: "prodma_user_id", value: "17" },
              ],
            },
          ],
        },
      ];
    }

    return [];
  },
});
```

A connector may declare several access-source families. `resource.entityType`
resolves the source key to an existing project access-resource type. Omitting it
defaults to the shipped `$resource` type, which is the correct shape for Slack
channels and GitHub repositories. Resolution is identity-first; a connector must
not attach an audience to a same-named entity by guesswork.

The server reuses the shipped access-graph engine:

```text
resolve identities
→ create/reuse access resource
→ create direct member_of edges
→ reconcile departures
→ mark ACL source fresh
```

A connector must return a complete effective audience snapshot for each resource.
Fetch failure is not an empty audience; it leaves the source stale and therefore
fail-closed.

## Client SDK

Normal readers do not change:

```ts
await client.entities.list({ entity_type: "invoice" });
await client.entities.get({ entity_id: 123 });
await client.query("SELECT * FROM invoice WHERE status = 'draft'");
```

They return only visible rows.

A small trusted namespace manages and explains access:

```ts
await client.access.check({
  entity_id: 123,
});

await client.access.explain({
  entity_id: 123,
});

await client.access.listMembers({
  resource_entity_id: 17,
});

await client.access.replaceMembers({
  resource_entity_id: 17,
  member_entity_ids: [42, 81],
});
```

`replaceMembers` uses the same reconciliation path and protected ACL-edge
privilege as connector sync. It is accepted only for a manual-authority resource;
source-owned resources remain read-only on this surface.

Generic relationship methods continue refusing authorization-bearing
`member_of` changes:

```ts
client.entities.link(...)   // cannot mint access
client.entities.unlink(...) // cannot revoke access
```

The first access-management release can be admin-only. Group authoring, temporary
grants, and delegated access management are later UI concerns.

## `lobu apply`

`lobu apply` owns stable policy:

- which entity types are access resources;
- which fields form each entity type's visibility envelope;
- optional resource binding for action definitions.

It does not normally own volatile runtime facts:

- which employees are in a group;
- who currently belongs to a warehouse;
- a source-side membership removal;
- temporary auditor access;
- approval decisions.

### Apply safety

Changing a type from workspace-visible to scoped requires a preflight over
existing rows. The apply blocks if any row has a missing or invalid required
resource.

Changing a type from scoped to workspace-visible is a security widening. It must
be explicitly declared and prominently rendered. Omission or `--prune` must
never silently widen visibility.

An access-resource declaration and visibility rule are security-owned facets:
ordinary schema drift handling must not accidentally clear them.

## ERP examples

| Domain object | Visibility envelope |
| --- | --- |
| Product catalogue | `[]` or `[Plant]` |
| Quote/order/invoice/payment/journal | `[Legal Entity]` |
| Stock movement/lot | `[Legal Entity, Warehouse]` |
| Work order/resource/work centre | `[Legal Entity, Plant]` |
| Cost allocation/actual cost | `[Legal Entity, Costing Scope]` |
| Fixed asset | `[Legal Entity]` |
| Payroll record | `[Payroll Scope]` |
| Confidential customer project | `[Project]` |
| Group consolidation output | every legal entity included in the output |

The Prodma project must add the relevant access-reference fields where its
single-company demo currently omits them. That is project schema work, not a new
ERP subsystem in Lobu.

## Security boundaries and non-goals

### Read ACL only

The visibility envelope is primarily a read boundary. Authoritative ERP writes
continue through deterministic source/domain actions.

A project that allows direct human edits to stored scoped entities must also
bind the existing write tier to the current and destination resources. In the
first ERP deployment, connector-managed projections should not expose ordinary
member mutation of visibility fields.

### Sensitive fields

Do not add generic field-level ACL.

Split data into separately protected entities:

```text
Employee
Employee Compensation
Employee Medical Record
```

Search, embeddings, metrics, summaries, exports, and audit then inherit one
object-level envelope consistently.

### Uncompilable source policy

If a source ACL depends on dynamic conditions Lobu cannot reproduce safely, use
per-user source retrieval or keep the data owner-only. Never approximate it with
a broader audience.

### Hard real-time control

PLC/MES safety loops remain outside Lobu. Lobu may consume significant events and
execute governed business commands; it is not an industrial real-time
authorization runtime.

## Delivery plan

### P0 — generic scoped data

1. **Entity visibility core**
   - proposed config authoring and schema extension;
   - access-resource type validation;
   - member resolution and shared visibility compiler;
   - list/get/search/write-move tests.

2. **No-bypass reads**
   - `query_sql`, Automation sources, views, derived entities;
   - `resolve_path`, relationship reads, reference lookups, counts;
   - event gate uses all required resources.

3. **Trusted access management and connector registration**
   - `client.access`;
   - dynamic custom connector `syncAccess`;
   - transactional membership reconciliation and audit;
   - freshness tests.

4. **Resource-bound operational artifacts**
   - action target binding;
   - run, approval, notification, and result inheritance;
   - restricted interaction events do not use a broad org-visible exemption.

Estimated first implementation: roughly **1,200–2,000 production lines** plus
**2,500–4,500 lines of positive/negative security tests**, across four focused
PRs. The test surface is larger than the implementation because every reader
must prove both allow and deny outcomes.

### Conditional P0 — unattended restricted Automations

- materialize agent/Automation principals;
- explicit resource memberships for autonomous actors;
- fixed-source output-envelope propagation;
- fail closed when provenance is incomplete.

### P1

- arbitrary SDK/tool-read envelope accumulation;
- access explanation UI;
- group authoring compiled to effective audiences;
- temporary grants and audited break-glass;
- filtered-result disclosure;
- optional materialized resource labels after measurement.

### Deliberately defer

- explicit deny relations;
- per-resource write-role vocabulary;
- field-level ACL;
- arbitrary ABAC;
- resource hierarchy;
- external ReBAC infrastructure.

## Acceptance tests

The feature is not complete until the same fixtures pass through every read
surface:

```text
Alice member_of UK
Bob member_of DE
CFO member_of UK and DE

UK invoice            → Alice + CFO, not Bob
DE invoice            → Bob + CFO, not Alice
UK/Warehouse A stock  → only members of both
UK+DE consolidation   → CFO only
workspace product     → every workspace member
```

Required negative cases:

- direct entity ID lookup does not bypass the gate;
- search does not reveal hidden names or counts;
- relationship reads do not reveal a hidden endpoint;
- SQL does not bypass typed entity reads;
- missing/invalid required resource fails closed;
- stale connector ACL hides source-owned data;
- a source fetch error does not reconcile to an empty audience;
- a source-owned resource rejects manual membership replacement;
- deleting or merging a referenced access resource does not widen dependants;
- an unlabeled shared-account source row fails closed;
- an approval for a restricted target is not visible org-wide;
- a derived output never has a weaker envelope than any input;
- a generic caller cannot create or delete `member_of` edges;
- an autonomous actor without explicit membership sees no restricted data.

## Final invariant

```text
Access resources describe who may see data.
Operation policy describes what may be done.
Domain code decides whether the operation is valid.
```

That is the complete consolidation. Everything else is either authoring UX,
source-specific ACL compilation, or enforcement coverage around the same
primitive.
