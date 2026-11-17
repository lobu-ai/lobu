import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";
import { CHAT_AUTOMATION_EVENTS } from "./chat-automation-events.js";
import { CHAT_TRANSPORT_ACTIONS } from "./chat-transport-actions.js";

export default class TeamsConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "teams",
		kind: "integration",
		automationEvents: CHAT_AUTOMATION_EVENTS,
		actions: CHAT_TRANSPORT_ACTIONS,
		name: "Microsoft Teams",
		description: "Connect a Microsoft Teams bot to Lobu.",
		version: "1.0.0",
		faviconDomain: "microsoft.com",
		authSchema: { methods: [{ type: "none", label: "Bot credentials" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "teams",
			properties: {
				appId: { type: "string", title: "App ID" },
				appPassword: {
					type: "string",
					format: "password",
					title: "App password",
				},
				appTenantId: { type: "string", title: "Tenant ID" },
				appType: {
					type: "string",
					title: "App type",
					enum: ["MultiTenant", "SingleTenant"],
				},
			},
			required: ["appId", "appPassword"],
		},
	};
}
