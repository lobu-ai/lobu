import { describe, expect, test } from "bun:test";
import GoogleChatConnector from "../gchat";

describe("Google Chat connector definition", () => {
	test("exposes the project-local Lobu command mapping", () => {
		const definition = new GoogleChatConnector().definition;
		const properties = definition.optionsSchema?.properties as
			| Record<string, Record<string, unknown>>
			| undefined;

		expect(definition.version).toBe("1.0.3");
		expect(properties?.helpCommandId).toMatchObject({
			type: "string",
			pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
			title: "Lobu command ID",
		});
	});

	test("declares the hosted app's Google-signed app webhook", () => {
		const webhook = new GoogleChatConnector().definition.webhook;
		expect(webhook).toMatchObject({
			delivery: "app_installation",
			deliveryKind: "chat",
			verification: {
				type: "google-jwt",
				appIdKey: "GOOGLE_CHAT_PROJECT_NUMBER",
			},
		});
		expect(webhook?.signatureHeader).toBeUndefined();
	});
});
