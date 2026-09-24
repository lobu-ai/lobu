import type { ViewAttachment } from "./manage-views";

type EventAttachment = Extract<ViewAttachment, { event_kind: string }>;
type ViewPlacement = "tab" | "overview";

/** An event's type qualifies its linked entities; it never names a page tab. */
export function isEventAttachment(
  attachment: ViewAttachment
): attachment is EventAttachment {
  return (
    "event_kind" in attachment && typeof attachment.event_kind === "string"
  );
}

export function isTabAttachment(attachment: ViewAttachment): boolean {
  return (
    !isEventAttachment(attachment) && (attachment.placement ?? "tab") === "tab"
  );
}

export function matchesType(
  attachment: ViewAttachment,
  typeSlug: string,
  placement: ViewPlacement
): boolean {
  return (
    !isEventAttachment(attachment) &&
    "type" in attachment &&
    attachment.type === typeSlug &&
    (attachment.placement ?? "tab") === placement
  );
}

export function matchesRecord(
  attachment: ViewAttachment,
  record: { type: string; id: number; slug: string; parentId: number | null },
  placement: ViewPlacement
): boolean {
  if (isEventAttachment(attachment)) return false;
  if ((attachment.placement ?? "tab") !== placement) return false;
  if ("entity" in attachment) {
    return typeof attachment.entity === "number"
      ? attachment.entity === record.id
      : record.parentId === null && attachment.entity === record.slug;
  }
  return matchesType(attachment, record.type, placement);
}

export function hasWorkspaceAttachment(
  attach: readonly ViewAttachment[]
): boolean {
  return attach.some(
    (attachment) =>
      !isEventAttachment(attachment) &&
      "workspace" in attachment &&
      attachment.workspace === true
  );
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
        semanticType === undefined || attachment.event_kind === semanticType
    );
}
