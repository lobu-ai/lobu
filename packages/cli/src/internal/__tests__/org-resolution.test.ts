/**
 * Org-slug resolution in `resolveApiClient` fails closed: with several orgs and
 * no explicit choice it refuses to guess, and a malformed slug is rejected.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { resolveApiClient } from "../api-client.js";
import * as context from "../context.js";
import * as credentials from "../credentials.js";

function makeUserInfoFetch(
  orgs: Array<{ slug: string; name?: string }>
): typeof fetch {
  return (async (_url, _init) => {
    return new Response(JSON.stringify({ sub: "u1", organizations: orgs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("resolveApiClient — org resolution", () => {
  beforeEach(() => {
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_TOKEN;

    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(context, "findContextByUrl").mockResolvedValue(undefined);
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  afterEach(() => {
    mock.restore();
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_TOKEN;
  });

  test(">1 orgs → throws 'Multiple organizations' error listing them", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    await expect(
      resolveApiClient({
        fetchImpl: makeUserInfoFetch([
          { slug: "alpha-org" },
          { slug: "beta-org" },
        ]),
      })
    ).rejects.toThrow(/Multiple organizations/);
  });

  test("invalid org slug (uppercase) causes a validation error", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    await expect(
      resolveApiClient({
        org: "INVALID_SLUG",
        fetchImpl: makeUserInfoFetch([]),
      })
    ).rejects.toThrow(/Invalid organization slug/);
  });
});
