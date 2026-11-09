import {
  type CollectionSelection,
  selectionImplies,
} from "./collection-selection";
import type { ViewAttachment } from "./manage-views";

type EventAttachment = Extract<ViewAttachment, { event: string }>;

export function isEventAttachment(
  attachment: ViewAttachment
): attachment is EventAttachment {
  return "event" in attachment;
}

/** A tab on the type's list page, when the list's selection implies `when`. */
export function matchesCollection(
  attachment: ViewAttachment,
  typeSlug: string,
  selection: CollectionSelection = {}
): boolean {
  return (
    "collection" in attachment &&
    attachment.collection === typeSlug &&
    (!attachment.when || selectionImplies(selection, attachment.when))
  );
}

/** A card on the record's page: every record of the type, or one pinned id. */
export function matchesRecord(
  attachment: ViewAttachment,
  record: { type: string; id: number | string | null }
): boolean {
  return (
    "record" in attachment &&
    attachment.record === record.type &&
    (attachment.id === undefined || attachment.id === record.id)
  );
}

/**
 * Whether the view mounts on records of `typeSlug`: a tab on the type's list
 * or a card on its record pages. With `recordId`, a record card pinned to
 * another id does not count. A collection's `when` narrows what the tab
 * shows, not which records the view is about, so it is ignored here.
 */
export function attachesToEntityType(
  attach: readonly ViewAttachment[],
  typeSlug: string,
  recordId?: number
): boolean {
  return attach.some(
    (attachment) =>
      ("collection" in attachment && attachment.collection === typeSlug) ||
      ("record" in attachment &&
        attachment.record === typeSlug &&
        (recordId === undefined ||
          attachment.id === undefined ||
          attachment.id === recordId))
  );
}

export function hasWorkspaceAttachment(
  attach: readonly ViewAttachment[]
): boolean {
  return attach.some((attachment) => "workspace" in attachment);
}

/** Without a kind, the web host considers every event attachment a candidate. */
export function eventAttachmentsFor(
  attach: readonly ViewAttachment[],
  semanticType?: string
): EventAttachment[] {
  return attach
    .filter(isEventAttachment)
    .filter(
      (attachment) =>
        semanticType === undefined || attachment.event === semanticType
    );
}
