import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";
import { CHAT_AUTOMATION_EVENTS } from "./chat-automation-events.js";

export default class WhatsAppConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "whatsapp",
		kind: "integration",
		automationEvents: CHAT_AUTOMATION_EVENTS,
		name: "WhatsApp Cloud",
		description: "Connect a WhatsApp Cloud API phone number to Lobu.",
		version: "1.0.0",
		faviconDomain: "whatsapp.com",
		authSchema: { methods: [{ type: "none", label: "Cloud API credentials" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "whatsapp",
			properties: {
				accessToken: {
					type: "string",
					format: "password",
					title: "Access token",
				},
				phoneNumberId: { type: "string", title: "Phone number ID" },
				appSecret: { type: "string", format: "password", title: "App secret" },
				verifyToken: {
					type: "string",
					format: "password",
					title: "Verify token",
				},
			},
			required: ["accessToken", "phoneNumberId", "appSecret", "verifyToken"],
		},
	};
}
