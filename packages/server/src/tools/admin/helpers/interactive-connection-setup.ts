import { createAuthRun } from "../../../runs/queue-service";
import type { DbClient } from "../../../db/client";
import { createAuthProfile } from "../../../utils/auth-profiles";
import {
	ensureLiveBrowserProfile,
	type LiveBrowserProfileParams,
} from "../../../utils/live-browser-profile";

type InsertConnection = (
	db: DbClient,
	authProfileId: number | null,
	useSavepoint: boolean,
) => Promise<Record<string, unknown>[]>;

export async function createConnectionSetupBundle(params: {
	db: DbClient;
	interactive: boolean;
	pendingLiveBrowser?: LiveBrowserProfileParams;
	organizationId: string;
	connectorKey: string;
	displayName: string;
	createdByUserId: string;
	insertConnection: InsertConnection;
}): Promise<{
	rows: Record<string, unknown>[];
	authRunId: number | null;
}> {
	const pendingLiveBrowser = params.pendingLiveBrowser;
	if (pendingLiveBrowser) {
		return params.db.begin(async (tx) => {
			const profile = await ensureLiveBrowserProfile(pendingLiveBrowser, tx);
			return {
				rows: await params.insertConnection(tx, profile.id, true),
				authRunId: null,
			};
		});
	}
	if (!params.interactive) {
		return {
			rows: await params.insertConnection(params.db, null, false),
			authRunId: null,
		};
	}

	return params.db.begin(async (tx) => {
		const profile = await createAuthProfile(
			{
				organizationId: params.organizationId,
				connectorKey: params.connectorKey,
				displayName: `${params.displayName} (pairing)`,
				slug: `${params.connectorKey}-interactive-${Date.now()}`,
				profileKind: "interactive",
				authData: {},
				status: "pending_auth",
				createdBy: params.createdByUserId,
			},
			tx,
		);
		const rows = await params.insertConnection(tx, profile.id, true);
		const authRunId = await createAuthRun(
			{
				organizationId: params.organizationId,
				connectorKey: params.connectorKey,
				authProfileId: profile.id,
				createdByUserId: params.createdByUserId,
			},
			tx,
		);
		return { rows, authRunId };
	});
}
