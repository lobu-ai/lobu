/**
 * Login-only AgentID declaration, consumed by the gateway's genericOAuth path.
 * It declares no feeds or device runtime. Owner claims are not mapped into
 * Lobu's user profile; these scopes identify the agent without requesting the
 * human owner's name or email. See https://www.agentid.com/docs/custom.
 */

import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";

export default class AgentIdConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "agentid",
		kind: "integration",
		name: "AgentID",
		description:
			"Sign in with AgentID to create or access your Lobu account using your agent's verified identity.",
		version: "1.0.0",
		faviconDomain: "agentid.com",
		authSchema: {
			methods: [
				{
					type: "oauth",
					provider: "agentid",
					loginScopes: ["openid", "email", "profile"],
					requiredScopes: [],
					authorizationUrl: "https://auth.agentid.com/v0/authorize",
					tokenUrl: "https://auth.agentid.com/v0/token",
					userinfoUrl: "https://auth.agentid.com/v0/userinfo",
					clientIdKey: "AGENTID_CLIENT_ID",
					clientSecretKey: "AGENTID_CLIENT_SECRET",
					tokenEndpointAuthMethod: "client_secret_basic",
					usePkce: true,
					required: false,
					description:
						"Sign in with AgentID to create or access your Lobu account using your agent's verified identity.",
				},
			],
		},
	};
}
