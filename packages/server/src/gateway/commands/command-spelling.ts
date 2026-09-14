const LOBU_WRAPPER_PLATFORMS = new Set(["slack", "gchat"]);

/** Render the advertised command spelling for the target platform. */
export function formatChatCommand(platform: string, name: string): string {
  return LOBU_WRAPPER_PLATFORMS.has(platform) ? `/lobu ${name}` : `/${name}`;
}

/**
 * Platforms whose message text takes an angle-bracket hyperlink `<url|label>`,
 * mapped to the label escape that syntax needs there. Slack mrkdwn and Google
 * Chat `Message.text` share the spelling; every other surface would show it as
 * literal text, so they keep the bare URL they auto-linkify.
 *
 * The escape differs even where the syntax matches: labels are agent names, and
 * Slack decodes HTML entities while Google Chat does not — an entity there
 * would reach the reader as `&amp;`. A Map, not an object literal, so a
 * platform named `constructor` cannot resolve a prototype member.
 */
const PIPE_LINK_LABEL_ESCAPES = new Map<string, (label: string) => string>([
  [
    "slack",
    (label) =>
      label.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  ],
  // Also drops `|`, which would otherwise split the label from the URL.
  ["gchat", (label) => label.replace(/[<>|]/g, "")],
]);

/**
 * Render a labelled hyperlink in the target platform's own message syntax, so
 * a notice carrying a link stays clickable everywhere instead of being gated
 * to the one platform whose syntax it was written in.
 */
export function formatChatLink(
  platform: string,
  url: string,
  label: string,
): string {
  const escapeLabel = PIPE_LINK_LABEL_ESCAPES.get(platform);
  return escapeLabel
    ? `<${url}|${escapeLabel(label)}>`
    : `${label} — ${url}`;
}

/** Stateful commands are handled by the message bridge, before dispatch. */
export function normalizeStatefulChatCommand(
  text: string,
): "new" | "clear" | null {
  const match = text
    .trim()
    .toLowerCase()
    .match(/^\/(?:lobu\s+)?(new|clear)$/);
  return match?.[1] === "new" || match?.[1] === "clear" ? match[1] : null;
}
