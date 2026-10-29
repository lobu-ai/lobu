import { describe, expect, it } from "vitest";
import { withGenericOAuthRoutes } from "../generic-oauth-routes";

const reached = async () => new Response("reached", { status: 200 });

describe("generic OAuth route compatibility", () => {
  it.each(["null", "[]", "42", '"provider"', "{invalid"])(
    "rejects malformed legacy request bodies: %s", async (body) => {
      const response = await withGenericOAuthRoutes(reached)(new Request(
        "https://example.test/api/auth/sign-in/oauth2",
        { method: "POST", headers: { "content-type": "application/json" }, body },
      ));
      expect(response.status).toBe(400);
    },
  );

  it("passes unrelated requests through unchanged", async () => {
    const request = new Request("https://example.test/api/auth/get-session");
    const response = new Response("session");
    const handler = async (seen: Request) => (seen === request ? response : reached());
    expect(await withGenericOAuthRoutes(handler)(request)).toBe(response);
  });
});
