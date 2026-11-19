/**
 * Claim provider for a TENANT-scoped data install: a bundled connector whose
 * `app_installation` method declares `installShape: 'oauth-code-exchange'` plus
 * a `tenant` (the merchant's own host). The install callback parks the exchanged
 * grant on an org-less pending `app_installations` row; this provider binds it
 * into the org the installer confirms on the generic claim page — the same
 * pending→claim engine the chat installs use. No provider literal: everything
 * provider-specific comes from the declared method the gateway mounted.
 *
 * Binding:
 *  1. the auth profile the org's install for this tenant already links (a
 *     reinstall) or a new one; the tokens live ONLY there, as secret refs;
 *  2. the active install row (`auth_profile_id` → that profile), fenced against
 *     a silent cross-org move by the store's advisory-locked upsert;
 *  3. the org connection bound by `config.installation_ref`, with the tenant
 *     under the declared tenant param key so the connector knows its host;
 *  4. the consumed setup row keeps no token (`tokens_enc` dropped, `claimed`).
 */

import { decrypt } from "@lobu/core";
import type { ConnectorAuthAppInstallation } from "@lobu/connector-sdk";
import { type DbClient, getDb } from "../../db/client.js";
import {
	type AppInstallationStore,
	CrossOrgTransferBlockedError,
} from "../../lobu/stores/app-installation-store.js";
import { persistAuthCredentials } from "../../utils/auth-credential-secrets.js";
import {
	createAuthProfile,
	deleteAuthProfile,
} from "../../utils/auth-profiles.js";
import {
	ConnectionSlugConflictError,
	insertConnectionWithSlug,
	resolveNewConnectionSlug,
} from "../../utils/connections.js";
import { ensureConnectorInstalled } from "../../utils/ensure-connector-installed.js";
import type { TenantInstallTokenGrant } from "../installation/refresh-token-installation-token-provider.js";
import {
	type ClaimForeignBinding,
	ClaimMoveBlockedError,
	type ClaimProvider,
} from "./connection-claim.js";

/** One mounted tenant data install (declared, deployment-wide). */
export interface TenantDataInstall {
	connectorKey: string;
	provider: string;
	displayName: string;
	method: ConnectorAuthAppInstallation & {
		tenant: { param: string; pattern: string };
	};
}

// Deployment config, not shared state: every replica mounts the same bundled
// connectors at boot, so each one registers the identical set.
const mountedTenantDataInstalls = new Map<string, TenantDataInstall>();

export function registerTenantDataInstall(install: TenantDataInstall): void {
	mountedTenantDataInstalls.set(install.provider, install);
}

export function getTenantDataInstall(provider: string): TenantDataInstall | null {
	return mountedTenantDataInstalls.get(provider) ?? null;
}

interface PendingTenantInstall {
	id: number;
	provider_instance: string;
	provider_app_id: string;
	external_tenant_id: string;
	status: string;
	metadata: {
		external_id: string;
		installer_user_id: string;
		connector_key: string;
		tokens_enc?: string;
		claimed?: boolean;
	};
}

export function tenantInstallClaimProvider(
	install: TenantDataInstall,
	deps: { store: AppInstallationStore },
): ClaimProvider<PendingTenantInstall> {
	const sql = getDb();
	const { provider, connectorKey, displayName } = install;
	const tenantParam = install.method.tenant.param;

	const read = async (
		ref: string,
		tx: DbClient = sql,
	): Promise<PendingTenantInstall | null> => {
		if (!ref || ref.length > 64) return null;
		const [row] = await tx`
			SELECT id, provider_instance, provider_app_id, external_tenant_id, status, metadata
			FROM app_installations
			WHERE provider = ${provider}
				AND organization_id IS NULL
				AND metadata->>'external_id' = ${ref}
			LIMIT 1
		`;
		return (row as PendingTenantInstall | undefined) ?? null;
	};

	const tuple = (pending: PendingTenantInstall) => ({
		provider,
		providerInstance: pending.provider_instance,
		providerAppId: pending.provider_app_id,
		externalTenantId: pending.external_tenant_id,
	});

	const elsewhere = async (
		pending: PendingTenantInstall,
		organizationId: string,
	): Promise<ClaimForeignBinding | null> => {
		const [row] = await sql`
			SELECT o.slug AS "orgSlug", o.name AS "orgName"
			FROM app_installations ai
			JOIN organization o ON o.id = ai.organization_id
			WHERE ai.provider = ${provider}
				AND ai.provider_instance = ${pending.provider_instance}
				AND ai.provider_app_id = ${pending.provider_app_id}
				AND ai.external_tenant_id = ${pending.external_tenant_id}
				AND ai.status = 'active'
				AND ai.organization_id <> ${organizationId}
			LIMIT 1
		`;
		return row
			? { orgSlug: row.orgSlug, orgName: row.orgName, matchKind: "same_workspace" }
			: null;
	};

	/** Create or reactivate the org connection bound to the install row. */
	const linkConnection = async (
		organizationId: string,
		installId: number,
		tenant: string,
		userId: string,
	): Promise<void> => {
		await sql.begin(async (tx) => {
			await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1))", [
				`tenant_app_install_connection:${organizationId}:${installId}`,
			]);
			const [existing] = await tx`
				SELECT id FROM connections
				WHERE organization_id = ${organizationId}
					AND connector_key = ${connectorKey}
					AND deleted_at IS NULL
					AND config ->> 'installation_ref' = ${String(installId)}
				ORDER BY id ASC
				LIMIT 1
			`;
			if (existing) {
				await tx`
					UPDATE connections
					SET status = 'active', updated_at = NOW()
					WHERE id = ${existing.id} AND organization_id = ${organizationId}
				`;
				return;
			}
			const name = `${displayName} (${tenant})`;
			const slugResult = await resolveNewConnectionSlug({
				organizationId,
				connectorKey,
				displayName: name,
				db: tx,
			});
			if ("error" in slugResult) throw new Error(slugResult.error);
			await insertConnectionWithSlug<Array<{ id: number }>>({
				organizationId,
				connectorKey,
				displayName: name,
				initialSlug: slugResult.slug,
				explicit: false,
				db: tx,
				doInsert: (slug) => tx`
					INSERT INTO connections (
						organization_id, connector_key, slug, display_name, status, config, created_by
					) VALUES (
						${organizationId}, ${connectorKey}, ${slug}, ${name}, 'active',
						${tx.json({ installation_ref: installId, [tenantParam]: tenant })}, ${userId}
					)
					RETURNING id
				`,
			}).catch((err) => {
				if (err instanceof ConnectionSlugConflictError) throw new Error(err.message);
				throw err;
			});
		});
	};

	return {
		provider,
		subjectKind: tenantParam,
		resolvePending: async (ref) => {
			const row = await read(ref);
			return row?.status === "pending" &&
				!row.metadata.claimed &&
				typeof row.metadata.tokens_enc === "string"
				? row
				: null;
		},
		// The installer started the install from a signed-in Lobu session and the
		// provider's OAuth proved they administer the tenant; only they may claim.
		authorize: async (userId, pending) =>
			pending.metadata.installer_user_id === userId
				? { status: "authorized", subjectName: pending.external_tenant_id }
				: { status: "not_authorized", code: "not_installer" },
		resolveExistingBinding: async (ref, userId) => {
			const pending = await read(ref);
			if (!pending?.metadata.claimed || pending.metadata.installer_user_id !== userId) {
				return null;
			}
			const [row] = await sql`
				SELECT o.slug FROM app_installations ai
				JOIN organization o ON o.id = ai.organization_id
				JOIN member m ON m."organizationId" = o.id AND m."userId" = ${userId}
				WHERE ai.provider = ${provider}
					AND ai.provider_instance = ${pending.provider_instance}
					AND ai.provider_app_id = ${pending.provider_app_id}
					AND ai.external_tenant_id = ${pending.external_tenant_id}
					AND ai.status = 'active'
				LIMIT 1
			`;
			return row ? { orgSlug: row.slug as string } : null;
		},
		resolveActiveBindingElsewhere: async (_ref, pending, organizationId) =>
			elsewhere(pending, organizationId),
		bind: async (pending, organizationId, userId, confirmMove) =>
			sql.begin(async (tx) => {
				const [current] = await tx`
					SELECT status, metadata FROM app_installations
					WHERE id = ${pending.id} AND organization_id IS NULL
					FOR UPDATE
				`;
				const metadata = current?.metadata as PendingTenantInstall["metadata"] | undefined;
				if (
					!current ||
					current.status !== "pending" ||
					metadata?.claimed ||
					typeof metadata?.tokens_enc !== "string"
				) {
					throw new Error(`${displayName} setup link expired`);
				}
				if (metadata.installer_user_id !== userId) {
					throw new Error(`${displayName} installation authority changed`);
				}
				const grant = JSON.parse(decrypt(metadata.tokens_enc)) as TenantInstallTokenGrant;

				await ensureConnectorInstalled({ organizationId, connectorKey });
				const existing = await deps.store.getByTenantAndOrg(tuple(pending), organizationId);
				let authProfileId = existing?.authProfileId ?? null;
				let createdProfileSlug: string | null = null;
				if (authProfileId == null) {
					const profile = await createAuthProfile({
						organizationId,
						connectorKey,
						displayName: `${displayName} (${pending.external_tenant_id})`,
						profileKind: "env",
						provider,
						createdBy: userId,
					});
					authProfileId = Number(profile.id);
					createdProfileSlug = profile.slug;
				}

				let row: Awaited<ReturnType<AppInstallationStore["upsert"]>>;
				try {
					row = await deps.store.upsert({
						organizationId,
						...tuple(pending),
						authProfileId,
						status: "active",
						metadata: {
							connector_key: connectorKey,
							installer_user_id: userId,
						},
						blockCrossOrgTransfer: !confirmMove,
						revokeConnectionsOnTransfer: confirmMove
							? { errorMessage: `${displayName} installation moved to another workspace` }
							: undefined,
					});
				} catch (error) {
					if (createdProfileSlug) {
						await deleteAuthProfile(organizationId, createdProfileSlug).catch(() => undefined);
					}
					if (error instanceof CrossOrgTransferBlockedError) {
						const foreign = await elsewhere(pending, organizationId);
						if (foreign) throw new ClaimMoveBlockedError(foreign);
					}
					throw error;
				}

				await persistAuthCredentials({
					organizationId,
					authProfileId,
					credentials: { ...grant },
				});
				await linkConnection(organizationId, row.id, pending.external_tenant_id, userId);
				// The setup row stays org-less (never mistaken for an org's install)
				// and no longer carries the grant.
				await tx`
					UPDATE app_installations
					SET metadata = (metadata - 'tokens_enc') || '{"claimed":true}'::jsonb,
						updated_at = now()
					WHERE id = ${pending.id}
				`;
				return { bindingId: String(row.id) };
			}),
	};
}
