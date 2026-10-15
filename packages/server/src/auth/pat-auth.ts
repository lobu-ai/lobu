/**
 * Shared Personal Access Token (PAT) authentication.
 *
 * One implementation of the `owl_pat_*` bearer path used by the embedded Agent
 * API auth bridge (`createLobuAuthBridge`): verify the token, reject null-org /
 * cross-tenant PATs, and resolve the authenticated user + org. (The managed-
 * connector connection-token router does NOT use this — it verifies OAuth
 * access tokens via `provider.verifyAccessToken`, since the local resolver
 * sends the user's `lobu login` token, not a PAT.)
 */

import type { DbClient } from "../db/client";
import type { AuthInfo } from "./oauth/types";
import { PersonalAccessTokenService } from "./tokens";
import { organizationIdLiveSql } from "../workspace/deletion-state";

const PAT_PREFIX = "owl_pat_";

interface PatUserRow {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
}

interface PatAuthSuccess {
	ok: true;
	userId: string;
	organizationId: string;
	/** The PAT's granted scopes, so callers can enforce least-privilege gates. */
	scopes: string[];
	/** The resolved user row, so callers can hydrate their session context. */
	user: PatUserRow;
	/** Raw verify() output (clientId/expiresAt/scopes) for session hydration. */
	patInfo: AuthInfo;
}

interface PatAuthFailure {
	ok: false;
	status: 401 | 403;
	error: string;
	error_description: string;
}

type PatAuthResult = PatAuthSuccess | PatAuthFailure;

/**
 * Extract a `owl_pat_*` bearer value from an Authorization header, or `null`
 * when the header is absent or does not carry a PAT.
 *
 * The auth scheme token (`Bearer`) is matched case-insensitively per RFC 7235
 * §2.1, and the `owl_pat_` prefix is detected case-insensitively, so a request
 * sending `bearer owl_pat_*` is still recognized as a PAT (and validated)
 * rather than silently masked behind cookie auth. The token VALUE handed to
 * verify() is unchanged — PAT hashes are case-sensitive on the bytes.
 */
export function extractPatBearer(
	authHeader: string | null | undefined,
): string | null {
	const bearerMatch = authHeader ? /^bearer\s+(.*)$/i.exec(authHeader) : null;
	const bearerValue = bearerMatch ? (bearerMatch[1] ?? "").trim() : null;
	if (
		!bearerValue ||
		bearerValue.slice(0, PAT_PREFIX.length).toLowerCase() !== PAT_PREFIX
	) {
		return null;
	}
	return bearerValue;
}

/**
 * Verify a `owl_pat_*` bearer and resolve the authenticated (user, org).
 *
 * Returns a discriminated result rather than throwing so callers can map it to
 * their own response shape. On any failure the status is the HTTP code the
 * caller should return:
 *   - 401 — invalid/expired/revoked PAT, null org, or owner no longer exists.
 *   - 403 — owner is no longer a member of the org the PAT is bound to.
 */
export async function authenticatePat(
	sql: DbClient,
	bearerValue: string,
): Promise<PatAuthResult> {
	let patInfo: AuthInfo | null;
	try {
		patInfo = await new PersonalAccessTokenService(sql).verify(bearerValue);
	} catch {
		return {
			ok: false,
			status: 401,
			error: "invalid_token",
			error_description: "PAT verification failed",
		};
	}

	if (!patInfo?.userId) {
		return {
			ok: false,
			status: 401,
			error: "invalid_token",
			error_description: "PAT is invalid, expired, or revoked",
		};
	}

	// Reject PATs with null organization_id: the FK is `ON DELETE SET NULL`, so a
	// PAT bound to a since-deleted org would otherwise silently re-resolve to an
	// unrelated org via default-org resolution.
	if (!patInfo.organizationId) {
		return {
			ok: false,
			status: 401,
			error: "invalid_token",
			error_description:
				"PAT is not scoped to an organization — re-mint via `lobu token`",
		};
	}

	const userRows = (await sql`
    SELECT id, name, email, "emailVerified"
    FROM "user"
    WHERE id = ${patInfo.userId}
    LIMIT 1
  `) as unknown as PatUserRow[];
	const user = userRows[0];
	if (!user) {
		return {
			ok: false,
			status: 401,
			error: "invalid_token",
			error_description: "PAT user no longer exists",
		};
	}

	// Tenant-membership check — a PAT for org A must still belong to org A.
	const memberRows = (await sql`
    SELECT 1
    FROM "member" m
    WHERE m."userId" = ${user.id}
      AND m."organizationId" = ${patInfo.organizationId}
      AND ${sql.unsafe(organizationIdLiveSql('m."organizationId"'))}
    LIMIT 1
  `) as unknown as Array<unknown>;
	if (memberRows.length === 0) {
		return {
			ok: false,
			status: 403,
			error: "forbidden",
			error_description: "Token owner is not a member of this organization",
		};
	}

	return {
		ok: true,
		userId: user.id,
		organizationId: patInfo.organizationId,
		scopes: patInfo.scopes,
		user,
		patInfo,
	};
}
