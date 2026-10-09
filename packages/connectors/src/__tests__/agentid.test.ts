import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after shared SDK mock
let AgentIdConnector: any;

beforeAll(async () => {
	const module = await import("../agentid");
	AgentIdConnector = module.default;
});

describe("AgentID connector declaration", () => {
	test("declares a self-describing OIDC login method for the genericOAuth route", () => {
		const connector = new AgentIdConnector();
		const methods = connector.definition.authSchema?.methods ?? [];
		const oauth = methods.find(
			(method: { type: string }) => method.type === "oauth",
		);

		expect(oauth?.provider).toBe("agentid");
		expect(oauth?.loginScopes).toEqual(["openid", "email", "profile"]);
		expect(oauth?.authorizationUrl).toBe(
			"https://auth.agentid.com/v0/authorize",
		);
		expect(oauth?.tokenUrl).toBe("https://auth.agentid.com/v0/token");
		expect(oauth?.userinfoUrl).toBe("https://auth.agentid.com/v0/userinfo");
		expect(oauth?.clientIdKey).toBe("AGENTID_CLIENT_ID");
		expect(oauth?.clientSecretKey).toBe("AGENTID_CLIENT_SECRET");
		expect(oauth?.tokenEndpointAuthMethod).toBe("client_secret_basic");
		expect(oauth?.usePkce).toBe(true);
	});
});
