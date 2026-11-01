import { afterEach, describe, expect, test } from "bun:test";
import { connectorWebhookCallbackUrl } from "../../connect/webhook-registration";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin";

const ORIGINAL_PUBLIC_GATEWAY_URL = process.env.PUBLIC_GATEWAY_URL;

afterEach(() => {
	if (ORIGINAL_PUBLIC_GATEWAY_URL === undefined) {
		delete process.env.PUBLIC_GATEWAY_URL;
	} else {
		process.env.PUBLIC_GATEWAY_URL = ORIGINAL_PUBLIC_GATEWAY_URL;
	}
	__resetPublicOriginCachesForTests();
});

describe("connectorWebhookCallbackUrl", () => {
	test("targets the /lobu gateway mount when only an origin is configured", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://app.lobu.ai";
		__resetPublicOriginCachesForTests();

		expect(connectorWebhookCallbackUrl(42)).toBe(
			"https://app.lobu.ai/lobu/api/v1/webhooks/42",
		);
	});

	test("preserves an explicitly configured gateway path", () => {
		process.env.PUBLIC_GATEWAY_URL = "https://gateway.example/custom-mount/";
		__resetPublicOriginCachesForTests();

		expect(connectorWebhookCallbackUrl(7)).toBe(
			"https://gateway.example/custom-mount/api/v1/webhooks/7",
		);
	});
});
