import { describe, expect, test } from "bun:test";
import type {
	ConnectorAuthAppInstallation,
	ConnectorAuthMethod,
	ConnectorDefinition,
	ConnectorInstallationContext,
	ConnectorWebhookSchema,
	SyncContext,
} from "../connector-types.js";
import { ConnectorRuntime } from "../connector-runtime.js";
import { defineConnector } from "../define-connector.js";

// PR1 of app_installation: purely additive connector-sdk types. These tests
// pin the shapes (they fail to COMPILE if the contract regresses) and assert a
// couple of runtime facts (defineConnector still lowers an app_installation
// authSchema unchanged; existing auth methods stay in the union).

describe("app_installation auth method", () => {
	test("a connector declaring an app_installation authSchema constructs and round-trips", () => {
		const Github = defineConnector({
			key: "github",
			name: "GitHub",
			version: "1.0.0",
			authSchema: {
				methods: [
					{
						type: "app_installation",
						provider: "github",
						providerInstance: "cloud",
						appIdKey: "GITHUB_APP_ID",
						privateKeyKey: "GITHUB_APP_PRIVATE_KEY",
						installUrlTemplate: "https://github.com/apps/lobu/installations/new",
						permissions: ["contents:read", "issues:write"],
						events: ["push", "issues"],
						required: true,
						description: "Install the Lobu GitHub App",
					},
				],
			},
			feeds: {
				items: {
					name: "Items",
					sync: async (ctx) => {
						await ctx.commit([], null);
						return { status: "complete" };
					},
				},
			},
		});

		expect(new Github()).toBeInstanceOf(ConnectorRuntime);
		const { definition } = new Github();
		const method = definition.authSchema?.methods[0];
		expect(method?.type).toBe("app_installation");
		// Narrow on the discriminant — fails to compile if the union dropped it.
		if (method?.type === "app_installation") {
			expect(method.provider).toBe("github");
			expect(method.appIdKey).toBe("GITHUB_APP_ID");
			expect(method.events).toEqual(["push", "issues"]);
		}
	});

	test("the existing auth methods remain assignable to the union (non-breaking)", () => {
		const methods: ConnectorAuthMethod[] = [
			{ type: "none" },
			{ type: "env_keys", fields: [{ key: "TOKEN" }] },
			{ type: "oauth", provider: "google", requiredScopes: [] },
			{ type: "browser" },
			{ type: "interactive" },
			{ type: "app_installation", provider: "slack" },
		];
		expect(methods.map((m) => m.type)).toEqual([
			"none",
			"env_keys",
			"oauth",
			"browser",
			"interactive",
			"app_installation",
		]);
	});

	test("only provider is required on the app_installation method", () => {
		const minimal: ConnectorAuthAppInstallation = {
			type: "app_installation",
			provider: "jira",
		};
		expect(minimal.providerInstance).toBeUndefined();
		expect(minimal.required).toBeUndefined();
	});
});

describe("webhook delivery mode", () => {
	test("delivery is optional — a webhook schema without it stays valid (back-compat default 'registered')", () => {
		const registered: ConnectorWebhookSchema = {
			signatureHeader: "x-hub-signature-256",
		};
		// `delivery` omitted == the documented 'registered' default; the field is
		// purely additive so existing schemas don't have to set it.
		expect(registered.delivery).toBeUndefined();
		expect(registered.routingKeyPath).toBeUndefined();
	});

	test("delivery accepts 'registered' and 'app_installation' with a routingKeyPath", () => {
		const appInstall: ConnectorWebhookSchema = {
			delivery: "app_installation",
			routingKeyPath: "installation.id",
		};
		const explicitRegistered: ConnectorWebhookSchema = {
			delivery: "registered",
		};
		expect(appInstall.delivery).toBe("app_installation");
		expect(appInstall.routingKeyPath).toBe("installation.id");
		expect(explicitRegistered.delivery).toBe("registered");
	});

	test("a connector definition can declare an app_installation webhook schema", () => {
		const def: ConnectorDefinition = {
			key: "github",
			name: "GitHub",
			version: "1.0.0",
			webhook: { delivery: "app_installation", routingKeyPath: "installation.id" },
		};
		expect(def.webhook?.delivery).toBe("app_installation");
	});
});

describe("installation context", () => {
	test("the installation shape is assignable on a SyncContext", () => {
		const installation: ConnectorInstallationContext = {
			id: "42",
			provider: "github",
			providerInstance: "cloud",
			providerAppId: "lobu-app",
			externalTenantId: "9876543",
			metadata: { account_login: "lobu-ai" },
		};

		const ctx: SyncContext = {
			feedKey: "items",
			config: {},
			checkpoint: null,
			credentials: null,
			entityIds: [],
			installation,
			commit: async () => {},
		};

		expect(ctx.installation?.id).toBe("42");
		expect(ctx.installation?.externalTenantId).toBe("9876543");
		expect(ctx.installation?.metadata?.account_login).toBe("lobu-ai");
	});

	test("installation is optional on the context (existing connectors omit it)", () => {
		const ctx: SyncContext = {
			feedKey: "items",
			config: {},
			checkpoint: null,
			credentials: null,
			entityIds: [],
			commit: async () => {},
		};
		expect(ctx.installation).toBeUndefined();
	});

	test("only id/provider/providerInstance/externalTenantId are required", () => {
		const minimal: ConnectorInstallationContext = {
			id: "1",
			provider: "slack",
			providerInstance: "cloud",
			externalTenantId: "T012345",
		};
		expect(minimal.providerAppId).toBeUndefined();
		expect(minimal.metadata).toBeUndefined();
	});
});
