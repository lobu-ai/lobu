/** Entity writes use canonical inputs and schema-validated metadata. */
import type { EntityCreateInput } from "@lobu/core/contracts/tools/manage-entity";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../../../index";
import { buildClientSDK, type ClientSDK } from "../../../sandbox/client-sdk";
import type { ToolContext } from "../../../tools/registry";
import { initWorkspaceProvider } from "../../../workspace";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import {
	addUserToOrganization,
	createTestOrganization,
	createTestUser,
	seedSystemEntityTypes,
} from "../../setup/test-fixtures";

const testEnv: Env = {
	ENVIRONMENT: "test",
	DATABASE_URL: process.env.DATABASE_URL,
};

const profile = {
	domain: "acme.example",
	category: "saas",
	platform_type: "b2b",
	main_market: "US",
	market: "DE",
	link: "https://acme.example",
};

describe("ClientSDK entities.create field pass-through", () => {
	let sdk: ClientSDK;

	beforeAll(async () => {
		await cleanupTestDatabase();
		await seedSystemEntityTypes();
		await initWorkspaceProvider();
		const org = await createTestOrganization({
			name: "Passthrough Org",
			slug: "passthrough-sdk",
		});
		const user = await createTestUser({
			email: "passthrough-sdk@test.example.com",
		});
		await addUserToOrganization(user.id, org.id, "owner");
		const ctx: ToolContext = {
			organizationId: org.id,
			userId: user.id,
			memberRole: "owner",
			isAuthenticated: true,
			tokenType: "oauth",
			scopes: ["mcp:read", "mcp:write", "mcp:admin"],
			scopedToOrg: false,
			allowCrossOrg: true,
		};
		sdk = buildClientSDK(ctx, testEnv);
		await sdk.entitySchema.createType({
			slug: "vendor", name: "Vendor",
			metadata_schema: {
				type: "object",
				properties: { ...Object.fromEntries(Object.keys(profile).map((field) => [field, { type: "string" }])), seats: { type: "integer" } },
				additionalProperties: false,
			},
		});
	});

	it("persists the profile fields the handler accepts", async () => {
		const result = (await sdk.entities.create({
			entity_type: "vendor",
			name: "Passthrough Co",
			metadata: profile,
		})) as { entity: { id: number; entity_type: string } };
		expect(result.entity.entity_type).toBe("vendor");
		// Assert on storage so this proves persistence, not just an argument echo.
		const rows = await getTestDb()`
			SELECT metadata FROM entities WHERE id = ${result.entity.id}`;
		expect(rows).toHaveLength(1);
		expect(rows[0].metadata).toMatchObject(profile);
	});

	it("validates metadata against the declared schema", async () => {
		await expect(sdk.entities.create({ entity_type: "vendor", name: "Invalid Co", metadata: { seats: "not-a-number" } })).rejects.toThrow(/seats/);
	});

	it("rejects retired type and id aliases", async () => {
		await expect(sdk.entities.create({ type: "vendor", name: "Alias Co" } as never)).rejects.toThrow(/unknown argument\(s\): type/);
		await expect(sdk.entities.get({ id: 1 } as never)).rejects.toThrow(/unknown argument\(s\): id/);
		await expect(sdk.entities.delete({ id: 1 } as never)).rejects.toThrow(/unknown argument\(s\): id/);
	});

	it("rejects top-level metadata shortcuts", async () => {
		await expect(sdk.entities.create({ entity_type: "vendor", name: "Shortcut Co", ...profile } as never)).rejects.toThrow(/unknown argument/);
	});

	it("rejects a field the contract does not accept instead of dropping it", async () => {
		await expect(
			sdk.entities.create({
				entity_type: "vendor",
				name: "Bogus Co",
				identities: [],
			} as unknown as EntityCreateInput),
		).rejects.toThrow(/unknown argument\(s\): identities/);
	});
});
