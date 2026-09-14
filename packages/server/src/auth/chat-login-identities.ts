/**
 * How each login provider's completed OAuth account yields the raw chat
 * principal (team id + platform user id) that its connector-owned
 * `ChatUserIdentity` then keys.
 *
 * This is the WRITE half of the chat-identity registry; the read half is
 * `lobu/stores/chat-identity-sources.ts`. They are split because reading needs
 * only the connector's key shape, while writing needs server-side provider
 * plumbing (stored id_tokens, the userinfo endpoint, provider config) that has
 * no place in a connector package.
 *
 * Each extractor is named after its provider on purpose — extracting a Slack
 * team id from an id_token claim is Slack knowledge, and the generic writer in
 * `subject-identities.ts` must not carry it. Adding a provider is one entry
 * here plus its connector's descriptor; the writer needs no edits.
 */

import type { ChatUserIdentity } from "@lobu/connectors/chat-user-identity";
import { gchatChatUserIdentity } from "@lobu/connectors/google-identity";
import { slackChatUserIdentity } from "@lobu/connectors/slack-identity";
import type { fetchUserInfoWithRaw } from "../connect/oauth-providers";
import type { getEnabledLoginProviderConfigs } from "./config";
import { decodeJwtClaims } from "./jwt-claims";

/**
 * The slice of a Better Auth social-login account an extractor may read.
 * Structurally satisfied by the `accountSummary` the auth hooks already build.
 */
export interface LoginAccountForChatIdentity {
	providerId: string;
	userId: string;
	accessToken?: string | null;
	/**
	 * The provider's external account id — the bare Slack `U…` sub, or the
	 * Google account id (the OIDC `sub`). Distinct from the Better Auth row PK.
	 */
	accountId?: string | null;
	/**
	 * The OIDC id_token Better Auth stored at the login code exchange. Slack's
	 * payload carries both `https://slack.com/team_id` and
	 * `https://slack.com/user_id`, so when present they are read straight from
	 * it — no second HTTP round-trip / provider-config lookup needed.
	 */
	idToken?: string | null;
}

/**
 * Injected boundary so tests can stub the network reads (userinfo fetch +
 * provider config) while exercising the real DB write path. This is the
 * `isolate: false` vitest-safe seam: the integration suite shares one module
 * graph, so `vi.mock` of these shared singletons is unreliable — dependency
 * injection is the durable alternative.
 */
export interface ChatLoginIdentityDeps {
	getEnabledLoginProviderConfigs: typeof getEnabledLoginProviderConfigs;
	fetchUserInfoWithRaw: typeof fetchUserInfoWithRaw;
}

/** The raw, un-keyed principal an extractor recovers from a login. */
export interface RawChatPrincipal {
	/** Tenant/workspace id, when the provider scopes user ids by one. */
	teamId?: string | null;
	/** The provider's bare user id. */
	platformUserId?: string | null;
	/** Where the values came from, for logging only. */
	source: string;
}

/** One provider's login → chat-principal extraction. */
export interface ChatLoginIdentity {
	/** The connector-owned key shape + namespace this login mints. */
	identity: ChatUserIdentity;
	/** Recover the raw principal, or null when this login cannot prove one. */
	extract(
		account: LoginAccountForChatIdentity,
		deps: ChatLoginIdentityDeps,
	): Promise<RawChatPrincipal | null>;
}

/**
 * Slack: the team id lives in a custom id_token claim, with the userinfo
 * endpoint as the fallback when no id_token was stored.
 */
const slackLoginIdentity: ChatLoginIdentity = {
	identity: slackChatUserIdentity,
	async extract(account, deps) {
		// The userinfo fallback needs a token, and without it there is no second
		// source for the team id.
		if (!account.accessToken) return null;

		// PRIMARY: read team + user straight out of the stored id_token. No network.
		if (account.idToken) {
			const claims = decodeJwtClaims(account.idToken);
			if (claims) {
				const teamId = claims["https://slack.com/team_id"] as
					| string
					| null
					| undefined;
				if (teamId) {
					return {
						teamId,
						platformUserId: (account.accountId ??
							claims["https://slack.com/user_id"] ??
							claims.sub) as string | null | undefined,
						source: "id_token",
					};
				}
			}
		}

		// FALLBACK: no id_token (or it yielded no team_id) → the userinfo endpoint.
		// One extra HTTP round-trip + a provider-config DB read.
		//
		// Resolve the Slack userinfo endpoint from the BASELINE catalog config
		// only (org id = null). We are about to send the user's real Slack OAuth
		// access token to `userinfoUrl`, so that URL must come from a trusted
		// source. An org-specific provider definition SHADOWS the baseline
		// (mergeLoginProviderConfigs), so reading it from any org the user belongs
		// to would let a tenant-controlled `userinfoUrl` receive the token — an
		// exfiltration vector, and unrelated to whichever org actually initiated
		// the OAuth exchange. The endpoint is a fixed provider property, identical
		// for every tenant, so the baseline is both correct and safe.
		const cfgs = await deps.getEnabledLoginProviderConfigs(null);
		const slackCfg = cfgs.find((c) => c.provider.toLowerCase() === "slack");
		const { raw } = await deps.fetchUserInfoWithRaw({
			provider: "slack",
			accessToken: account.accessToken,
			userinfoUrl: slackCfg?.userinfoUrl,
		});
		return {
			teamId: raw?.["https://slack.com/team_id"] as string | null | undefined,
			platformUserId: (account.accountId ??
				raw?.["https://slack.com/user_id"] ??
				raw?.sub) as string | null | undefined,
			source: "userinfo-fallback",
		};
	},
};

/**
 * Google: the account id Better Auth stored IS the OIDC `sub`, and that is the
 * same id Google Chat puts in a sender's `users/{id}` resource name — so no
 * token, no id_token decode, and no directory lookup is needed.
 *
 * There is nothing to scope it by either: a Google account id is unique across
 * all of Google, unlike a Slack `U…`, which only identifies a person within one
 * workspace.
 */
const googleLoginIdentity: ChatLoginIdentity = {
	identity: gchatChatUserIdentity,
	async extract(account) {
		if (!account.accountId) return null;
		return { platformUserId: account.accountId, source: "account_id" };
	},
};

/** Every login provider whose sign-in mints a chat identity. */
export const CHAT_LOGIN_IDENTITIES: readonly ChatLoginIdentity[] = [
	slackLoginIdentity,
	googleLoginIdentity,
];

const BY_PROVIDER = new Map<string, ChatLoginIdentity>(
	CHAT_LOGIN_IDENTITIES.map((e) => [e.identity.providerId, e]),
);

/**
 * The chat identity a given login provider mints, or null when signing in with
 * that provider proves no chat identity (github, email/password, …).
 */
export function chatLoginIdentityFor(
	providerId: string | null | undefined,
): ChatLoginIdentity | null {
	if (!providerId) return null;
	return BY_PROVIDER.get(providerId.trim().toLowerCase()) ?? null;
}
