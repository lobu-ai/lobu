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
  record: { type: string; id: number }
): boolean {
  return (
    "record" in attachment &&
    attachment.record === record.type &&
    (attachment.id === undefined || attachment.id === record.id)
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
