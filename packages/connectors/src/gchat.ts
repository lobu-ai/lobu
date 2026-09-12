import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";
import { CHAT_AUTOMATION_EVENTS } from "./chat-automation-events.js";

export default class GoogleChatConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "gchat",
		kind: "integration",
		automationEvents: CHAT_AUTOMATION_EVENTS,
		name: "Google Chat",
		description: "Connect a Google Chat app to Lobu.",
		version: "1.0.2",
		faviconDomain: "chat.google.com",
		authSchema: { methods: [{ type: "none", label: "Service account" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "gchat",
			properties: {
				credentials: {
					type: "string",
					format: "password",
					title: "Service account JSON",
				},
				googleChatProjectNumber: { type: "string", title: "Project number" },
				helpCommandId: {
					type: "string",
					pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
					title: "Lobu command ID",
					description:
						"Command ID (1-1000) configured for Lobu's native /lobu wrapper. Existing /help commands stay compatible.",
				},
				endpointUrl: { type: "string", title: "Endpoint URL" },
			},
			required: ["credentials", "googleChatProjectNumber"],
		},
	};
}
