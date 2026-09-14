/**
 * Allowlist for tenant-supplied chat `connection.settings`.
 *
 * WHY AN ALLOWLIST AND NOT A CHECK ON `previewMode`: chat `config` and chat
 * `settings` both end up in the same `connections.config` JSON column —
 * `settings` is folded in at persist time (`lobu/stores/connections-projection.ts`,
 * `foldedConfig`). Only `config` is validated, by `parseConfig`, whose
 * `Value.Clean` strips unknown keys; that is what keeps `action_modes` out of
 * chat rows. `settings` is typed `Record<string, any>` in the tool contract and
 * is spread verbatim in `upsertByoChatConnection`, so without this it is an
 * unvalidated door into the object the runtime reads its own operator flags
 * from. A denylist would admit every privileged key added after it was written;
 * an allowlist fails closed on the day one lands.
 *
 * `previewMode` is why this is not theoretical. It does not mark a "demo"
 * connection — it marks a connection as LOBU'S OWN hosted relay, and is read by
 * cross-organization message routing (`message-handler-bridge.ts`), unbound
 * `lobu run` claim redemption (`preview/slack.ts`), tenant notification
 * delivery through the shared bot (`bound-channels.ts`, the cross-org branch
 * `notifications/service.ts` delivers through), and the global
 * one-row-per-platform slot (`uniq_preview_connection_per_platform_all`). For a
 * platform where Lobu runs no hosted bot, that slot is unclaimed — and a tenant
 * taking it makes other tenants' link codes redeem through the seizing tenant's
 * bot.
 *
 * No application code writes `previewMode`: every occurrence in the repo is a
 * read, and Lobu's own preview rows are provisioned by an operator directly
 * against the database. So refusing it here breaks no legitimate caller.
 *
 * Refused rather than silently stripped, unlike unknown `config` keys. Stripping
 * is right for a field a caller merely got wrong; this is a caller asking for
 * cross-organization routing privilege, and the honest answer to that is no —
 * not yes-and-quietly-ignored. Same reasoning as `action-modes-guard.ts`, which
 * errors rather than dropping the map.
 *
 * WHY THE HANDLER AND NOT `upsertByoChatConnection`: the rule is about who is
 * asking, not about what may be stored. The service is the seam an OPERATOR
 * provisioning Lobu's own relay would go through, and that row must carry
 * `previewMode` — enforcing there would refuse the one caller allowed to set it.
 * `apply_chat_connection` is the tenant-facing door, so the gate belongs on it.
 */

/**
 * Settings a tenant owns on their own chat connection. Everything else is
 * operator-owned or unrecognised, and both are refused.
 *
 * These are the non-privileged members of `ConnectionSettings`
 * (`gateway/connections/types.ts`). A member added there later needs no edit
 * here for the gate to hold — an unrecognised key is already refused. Widening
 * this list is the deliberate act of handing tenants a new key, and a unit test
 * pins it so that act cannot be a silent one.
 */
export const TENANT_SETTABLE_CHAT_SETTINGS: readonly string[] = [
	"allowFrom",
	"allowGroups",
	"recordChannelMessages",
	"userConfigScopes",
];

const ALLOWED = new Set(TENANT_SETTABLE_CHAT_SETTINGS);

/**
 * Refuse a chat-connection `settings` object carrying any key a tenant may not
 * set. Returns null when every key is allowed (including no settings at all).
 *
 * Keys are judged on PRESENCE, not value: an allowlist decides which names a
 * caller may state at all, so `previewMode: false` is refused for the same
 * reason `previewMode: true` is.
 */
export function denyOperatorOnlyChatSettings(
	settings: Record<string, unknown> | undefined | null,
): { error: string } | null {
	if (!settings) return null;
	// `Object.keys` is deliberate: own enumerable keys only, matching what the
	// spread in `upsertByoChatConnection` would actually persist. A key reachable
	// only through the prototype chain never lands in the row, so refusing it
	// would reject a request that was never dangerous.
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
