/**
 * Allowlist for tenant-supplied chat `connection.settings`.
 *
 * Chat `config` and `settings` both land in the same `connections.config`
 * column, but only `config` is validated: `parseConfig`'s `Value.Clean` strips
 * unknown keys, while `settings` is typed `Record<string, any>` and spread
 * verbatim into the row. That makes it an unvalidated door into the object the
 * runtime reads its own operator flags from — chiefly `previewMode`, which
 * marks a connection as Lobu's shared hosted relay and steers cross-org message
 * routing, `lobu run` claim redemption and notification delivery, with one
 * global slot per platform (`uniq_preview_connection_per_platform_all`). A
 * tenant seizing an unclaimed slot makes other tenants' link codes redeem
 * through their bot.
 *
 * An allowlist, so a privileged key added later is refused on the day it lands.
 * Refused rather than stripped, like `action-modes-guard.ts`: the honest answer
 * to a request for cross-org privilege is no, not yes-and-quietly-ignored. On
 * the handler rather than `upsertByoChatConnection` because the service is also
 * the seam an operator provisioning Lobu's own relay goes through, and that row
 * must carry `previewMode`.
 */

/**
 * Settings a tenant owns on their own chat connection: the non-privileged
 * members of `ConnectionSettings` (`gateway/connections/types.ts`). A member
 * added there later needs no edit here — an unrecognised key is already
 * refused. A unit test pins this list so widening it cannot be silent.
 */
export const TENANT_SETTABLE_CHAT_SETTINGS: readonly string[] = [
	"allowFrom",
	"allowGroups",
	"recordChannelMessages",
	"userConfigScopes",
];

const ALLOWED = new Set(TENANT_SETTABLE_CHAT_SETTINGS);

/**
 * Refuse a `settings` object carrying any key a tenant may not set. Null when
 * every key is allowed (including no settings at all). Keys are judged on
 * PRESENCE: an allowlist decides which names a caller may state, so
 * `previewMode: false` is refused for the same reason `previewMode: true` is.
 */
export function denyOperatorOnlyChatSettings(
	settings: Record<string, unknown> | undefined | null,
): { error: string } | null {
	if (!settings) return null;
	// Own enumerable keys only, matching the spread that persists them: a key
	// reachable only through the prototype never lands in the row.
	const rejected = Object.keys(settings).filter((key) => !ALLOWED.has(key));
	if (rejected.length === 0) return null;
	return {
		error:
			`Connection settings not settable here: ${rejected.join(", ")}. ` +
			`Chat connections accept ${TENANT_SETTABLE_CHAT_SETTINGS.join(", ")}. ` +
			`Other settings are operator-owned — in particular 'previewMode', which ` +
			`marks a connection as Lobu's shared hosted relay and controls ` +
			`cross-organization message routing.`,
	};
}
