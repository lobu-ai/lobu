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
		version: "1.0.3",
		faviconDomain: "chat.google.com",
		webhook: {
			// The hosted Lobu Google Chat app posts every space's events to the
			// shared `/api/v1/app-webhooks/gchat` endpoint. Google signs each
			// delivery with a bearer JWT, not an HMAC: either self-signed by the
			// Chat service account for the project number, or a Google ID token
			// for the endpoint URL (Workspace Add-on apps sign as the project's
			// add-on identity). The generic engine verifies it from this
			// declaration; unset GOOGLE_CHAT_PROJECT_NUMBER = no hosted app (404).
			delivery: "app_installation",
			// Verified deliveries go to the Google Chat platform's chat delivery
			// (claimed space → its installation; otherwise the claim link).
			deliveryKind: "chat",
			verification: {
				type: "google-jwt",
				appIdKey: "GOOGLE_CHAT_PROJECT_NUMBER",
				audiences: ["app_id", "endpoint_url"],
				signers: [
					"chat@system.gserviceaccount.com",
					"service-{appId}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com",
				],
			},
			// The space sits in different places across Chat event envelopes.
			routingKeyPaths: [
				"space.name",
				"chat.messagePayload.space.name",
				"chat.addedToSpacePayload.space.name",
				"chat.removedFromSpacePayload.space.name",
				"chat.appCommandPayload.space.name",
			],
		},
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
