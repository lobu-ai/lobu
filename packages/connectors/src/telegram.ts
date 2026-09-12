import {
	type ConnectorDefinition,
	IntegrationConnector,
} from "@lobu/connector-sdk";
import { CHAT_AUTOMATION_EVENTS } from "./chat-automation-events.js";

export default class TelegramConnector extends IntegrationConnector {
	readonly definition: ConnectorDefinition = {
		key: "telegram",
		kind: "integration",
		automationEvents: CHAT_AUTOMATION_EVENTS,
		name: "Telegram",
		description: "Connect a Telegram bot and route chats to Lobu agents.",
		version: "1.0.0",
		faviconDomain: "telegram.org",
		authSchema: { methods: [{ type: "none", label: "Bot token" }] },
		optionsSchema: {
			type: "object",
			"x-lobu-chat-platform": "telegram",
			properties: {
				botToken: {
					type: "string",
					format: "password",
					title: "Bot token",
					description: "Bot token issued by BotFather.",
				},
				mode: {
					type: "string",
					title: "Delivery mode",
					enum: ["auto", "webhook", "polling"],
					default: "auto",
				},
			},
			required: ["botToken"],
		},
	};
}
