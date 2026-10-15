/**
 * Agent model reporting uses the cloud chat preflight's provider check with
 * the agent owner's credentials.
 *
 * The bug: `resolveAgentModelInfo` reported `not_runnable: false` whenever the
 * agent named any model ref, so an agent pinned to `gemini/<model>` in an org
 * with no gemini provider looked healthy while every chat message to it was
 * rejected with "no connected+routable model provider".
 */

import { type ModuleInterface, moduleRegistry } from "@lobu/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProviderCatalogService } from "../../gateway/auth/provider-catalog";
import { resolveAgentModelInfo } from "../../lobu/model-config";
import {
	createInferenceProvider,
	listInferenceProviders,
} from "../../lobu/stores/provider-secrets";
import { cleanupTestDatabase } from "../setup/test-db";
import {
	createTestAgent,
	createTestOrganization,
	createTestUser,
} from "../setup/test-fixtures";

const PUBLIC_GATEWAY_URL = "http://127.0.0.1:8787/lobu";

/** Real Postgres provider rows, with stubbed settings and no user auth profiles. */
function catalogFor(models: string[] | undefined): ProviderCatalogService {
	return new ProviderCatalogService(
		{ getSettings: async () => ({ models }) } as never,
		{
			getBestProfile: async () => null,
			hasProviderProfiles: async () => false,
		} as never,
		listInferenceProviders,
	);
}

async function seedAgent(orgName: string): Promise<{
	orgId: string;
	agentId: string;
}> {
	const org = await createTestOrganization({ name: orgName });
	const owner = await createTestUser({
		email: `${orgName.replace(/\W+/g, "-")}@test.example`,
	});
	const agent = await createTestAgent({
		organizationId: org.id,
		ownerUserId: owner.id,
	});
	return { orgId: org.id, agentId: agent.agentId };
}

async function addKeyedProvider(orgId: string): Promise<void> {
	const created = await createInferenceProvider({
		organizationId: orgId,
		slug: "synthetic-co",
		kind: "openai",
		apiKey: "sk-synthetic",
		capabilities: {
			text: {
				model: "synthetic-large",
				base_url: "https://synthetic.example.com/v1",
			},
		},
	});
	if ("error" in created) throw new Error("synthetic provider create failed");
}

describe("resolveAgentModelInfo reports the run path's routability", () => {
	const registry = moduleRegistry as unknown as {
		modules: Map<string, ModuleInterface>;
	};
	let previousModules: Map<string, ModuleInterface>;

	beforeAll(async () => {
		await cleanupTestDatabase();
		// No deployment system-key modules: only org rows can route.
		previousModules = registry.modules;
		registry.modules = new Map();
	});

	afterAll(() => {
		registry.modules = previousModules;
	});

	it("an agent pinned to a provider the org does not have is NOT runnable", async () => {
		const { orgId, agentId } = await seedAgent("runnability no providers");
		const models = ["gemini/gemini-2.5-pro"];

		const info = await resolveAgentModelInfo(models, orgId, {
			agentId,
			catalog: catalogFor(models),
			publicGatewayUrl: PUBLIC_GATEWAY_URL,
		});

		expect(info).toEqual({
			effective_model: "gemini/gemini-2.5-pro",
			source: "agent",
			not_runnable: true,
		});
	});

	it("a pin to a missing provider is NOT runnable even when the org has another keyed provider", async () => {
		const { orgId, agentId } = await seedAgent("runnability other provider");
		await addKeyedProvider(orgId);
		const models = ["chatgpt/gpt-5.6-sol"];

		const info = await resolveAgentModelInfo(models, orgId, {
			agentId,
			catalog: catalogFor(models),
			publicGatewayUrl: PUBLIC_GATEWAY_URL,
		});

		expect(info.source).toBe("agent");
		expect(info.not_runnable).toBe(true);
	});

	it("a pin to a keyed org provider IS runnable", async () => {
		const { orgId, agentId } = await seedAgent("runnability keyed pin");
		await addKeyedProvider(orgId);
		const models = ["synthetic-co/synthetic-large"];

		const info = await resolveAgentModelInfo(models, orgId, {
			agentId,
			catalog: catalogFor(models),
			publicGatewayUrl: PUBLIC_GATEWAY_URL,
		});

		expect(info).toEqual({
			effective_model: "synthetic-co/synthetic-large",
			source: "agent",
			not_runnable: false,
		});
	});

	it("an unroutable pin with a routable listed alternate IS runnable (the run falls back)", async () => {
		const { orgId, agentId } = await seedAgent("runnability alternate");
		await addKeyedProvider(orgId);
		const models = ["gemini/gemini-2.5-pro", "synthetic-co/synthetic-large"];

		const info = await resolveAgentModelInfo(models, orgId, {
			agentId,
			catalog: catalogFor(models),
			publicGatewayUrl: PUBLIC_GATEWAY_URL,
		});

		expect(info.effective_model).toBe("gemini/gemini-2.5-pro");
		expect(info.not_runnable).toBe(false);
	});

	it("an agent inheriting a keyed org default IS runnable", async () => {
		const { orgId, agentId } = await seedAgent("runnability org default");
		await addKeyedProvider(orgId);

		const info = await resolveAgentModelInfo(undefined, orgId, {
			agentId,
			catalog: catalogFor(undefined),
			publicGatewayUrl: PUBLIC_GATEWAY_URL,
		});

		expect(info).toEqual({
			effective_model: "synthetic-co/synthetic-large",
			source: "org_default",
			not_runnable: false,
		});
	});
});
