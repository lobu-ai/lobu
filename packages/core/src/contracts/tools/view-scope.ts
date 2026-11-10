import { type Static, Type } from "@sinclair/typebox";
import { CollectionSelectionSchema } from "./collection-selection";

// A view key names the module: lowercase, dashes, 1-64 chars. The folder is
// only a convention — the key is the identity (no `custom:<name>` prefix).
export const ViewKeySchema = Type.String({
  pattern: "^[a-z0-9][a-z0-9-]{0,63}$",
  minLength: 1,
  maxLength: 64,
  description: "View key, e.g. 'pipeline'.",
});

// What a view opens for: `open_view`'s scope, and a navigation entry's. The
// page it lands on follows from the view's attachments; scope is never
// inferred from where a link sits.
export const ViewScopeSchema = Type.Object(
  {
    collection: Type.Optional(CollectionSelectionSchema),
    type: Type.Optional(
      Type.String({
        minLength: 1,
        description: "Entity-type slug the view opens for.",
      })
    ),
    entity: Type.Optional(
      Type.Integer({ description: "Entity id the view opens for." })
    ),
    event: Type.Optional(
      Type.Integer({
        description:
          "Event id the view opens for. It names the event's supersede lineage, so the view shows the current version, and it opens at /events/<id>/-/views/<key>.",
      })
    ),
  },
  {
    description:
      "Required unless the view is attached to the workspace. Pass scope.type, scope.entity, or scope.event to select its subject.",
  }
);
export type ViewScopeInput = Static<typeof ViewScopeSchema>;

/** Which scope fields combine. `open_view`, a navigation entry and an
 *  embedded view all apply this one rule, so a scope one accepts the others
 *  accept too. Null when the combination is valid. */
export function viewScopeShapeError(scope: {
  type?: unknown;
  entity?: unknown;
  event?: unknown;
  collection?: unknown;
}): string | null {
  if (
    scope.collection !== undefined &&
    (!scope.type || scope.entity !== undefined || scope.event !== undefined)
  ) {
    return "Collection selection requires scope.type without entity or event";
  }
  if (
    scope.event !== undefined &&
    (scope.type !== undefined || scope.entity !== undefined)
  ) {
    return "scope.event names the view's subject on its own; drop scope.type and scope.entity";
  }
  return null;
}
