const LOBU_WRAPPER_PLATFORMS = new Set(["slack", "gchat"]);

/** Render the advertised command spelling for the target platform. */
export function formatChatCommand(platform: string, name: string): string {
  return LOBU_WRAPPER_PLATFORMS.has(platform) ? `/lobu ${name}` : `/${name}`;
}

/**
 * Platforms whose message text is Slack mrkdwn, where a clickable link is
 * written `<url|label>` and a bare URL renders as flat, unclickable text.
 * Every other chat surface (Telegram, Google Chat, Discord, Teams, WhatsApp)
 * auto-linkifies a bare URL, and would show `<url|label>` literally.
 */
const MRKDWN_LINK_PLATFORMS = new Set(["slack"]);

/**
 * Escape the mrkdwn control chars that break an inline `<url|label>` label.
 * Labels are user-controlled (agent names), and a raw `<`, `>` or `&` would
 * terminate or corrupt the link. Inert on platforms that take a bare URL.
 */
function escapeMrkdwnLabel(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
  return MRKDWN_LINK_PLATFORMS.has(platform)
    ? `<${url}|${escapeMrkdwnLabel(label)}>`
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
