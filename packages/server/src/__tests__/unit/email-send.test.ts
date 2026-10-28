import { createElement } from "react";
import { describe, expect, it } from "bun:test";
import type { Env } from "@lobu/connector-sdk";
import { sendTransactionalEmail } from "../../email/send";

const BASE_ENV = {
	CLOUDFLARE_EMAIL_ACCOUNT_ID: "test_account_id",
	CLOUDFLARE_EMAIL_API_TOKEN: "test_token",
	EMAIL_FROM_AUTH: "Lobu <auth@test.example.com>",
	EMAIL_FROM_INVITES: "Lobu <invites@test.example.com>",
	EMAIL_REPLY_TO: "reply@test.example.com",
	EMAIL_UNSUBSCRIBE: "mailto:unsub@test.example.com",
} as Env;

const REACT = createElement("div", null, "hello");

function mockFetchJson(payload: unknown, status = 200) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const original = globalThis.fetch;
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return {
		calls,
		restore: () => {
			globalThis.fetch = original;
		},
	};
}

describe("sendTransactionalEmail (Cloudflare)", () => {
	it("throws when Cloudflare credentials are missing", async () => {
		await expect(
			sendTransactionalEmail({
				env: {} as Env,
				to: "user@test.example.com",
				subject: "s",
				react: REACT,
				category: "auth",
			}),
		).rejects.toThrow("CLOUDFLARE_EMAIL_API_TOKEN");
	});

	it("throws when the category From address is missing", async () => {
		const { restore } = mockFetchJson({ success: true });
		try {
			const { EMAIL_FROM_AUTH: _omit, ...env } = BASE_ENV;
			await expect(
				sendTransactionalEmail({
					env: env as Env,
					to: "user@test.example.com",
					subject: "s",
					react: REACT,
					category: "auth",
				}),
			).rejects.toThrow("EMAIL_FROM_AUTH");
		} finally {
			restore();
		}
	});

	it("posts to the account send endpoint and returns the message id", async () => {
		const { calls, restore } = mockFetchJson({
			success: true,
			errors: [],
			messages: [],
			result: {
				delivered: [],
				message_id: "<abc123@test.example.com>",
				permanent_bounces: [],
				queued: ["user@test.example.com"],
				suppressed_recipients: [],
			},
		});
		try {
			const result = await sendTransactionalEmail({
				env: BASE_ENV,
				to: "user@test.example.com",
				subject: "Magic link",
				react: REACT,
				category: "auth",
			});
			expect(result).toEqual({ id: "<abc123@test.example.com>" });
			expect(calls).toHaveLength(1);
			expect(calls[0].url).toBe(
				"https://api.cloudflare.com/client/v4/accounts/test_account_id/email/sending/send",
			);
			const body = JSON.parse(calls[0].init.body as string) as Record<string, unknown>;
			expect(body.to).toBe("user@test.example.com");
			expect(body.from).toBe("Lobu <auth@test.example.com>");
			expect(body.reply_to).toBe("reply@test.example.com");
			expect(body.headers).toMatchObject({
				"List-Unsubscribe": "<mailto:unsub@test.example.com>",
				"List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
			});
			expect(body.text).toBeString();
			expect(body.html).toBeString();
		} finally {
			restore();
		}
	});

	it("throws fail-closed on API errors", async () => {
		const { restore } = mockFetchJson(
			{
				success: false,
				errors: [{ code: 10202, message: "email.sending.error.email.invalid" }],
				messages: [],
				result: null,
			},
			400,
		);
		try {
			await expect(
				sendTransactionalEmail({
					env: BASE_ENV,
					to: "user@test.example.com",
					subject: "s",
					react: REACT,
					category: "invite",
				}),
			).rejects.toThrow("10202");
		} finally {
			restore();
		}
	});

	it("throws when the recipient hard-bounced despite acceptance", async () => {
		const { restore } = mockFetchJson({
			success: true,
			errors: [],
			messages: [],
			result: {
				delivered: [],
				message_id: "<abc123@test.example.com>",
				permanent_bounces: ["user@test.example.com"],
				queued: [],
				suppressed_recipients: [],
			},
		});
		try {
			await expect(
				sendTransactionalEmail({
					env: BASE_ENV,
					to: "user@test.example.com",
					subject: "s",
					react: REACT,
					category: "auth",
				}),
			).rejects.toThrow("not delivered");
		} finally {
			restore();
		}
	});
});
