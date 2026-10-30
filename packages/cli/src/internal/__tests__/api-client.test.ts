import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { ApiClient, listOrganizations, resolveApiClient } from "../api-client";
import * as context from "../context";
import * as credentials from "../credentials";

describe("ApiClient", () => {
  test("request sends correct headers", async () => {
    const fetchMock = mock(async () => {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const client = new ApiClient(
      "https://api.example.com",
      "my-token",
      fetchMock as unknown as typeof fetch
    );
    const result = await client.get("/test");

    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.example.com/test");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer my-token",
      Accept: "application/json",
    });
  });

  test("request throws ApiClientError on failure", async () => {
    const fetchMock = mock(async () => {
      return new Response(
        JSON.stringify({ error: "Failed", message: "Error message" }),
        { status: 400 }
      );
    });

    const client = new ApiClient(
      "https://api.example.com",
      "my-token",
      fetchMock as unknown as typeof fetch
    );

    expect(client.get("/fail")).rejects.toThrow(
      "GET /fail failed: Error message"
    );
  });
});

describe("resolveApiClient", () => {
  beforeEach(() => {
    delete process.env.LOBU_API_TOKEN;
    delete process.env.LOBU_ORG;
  });

  afterEach(() => {
    mock.restore();
  });

  test("resolves the token from the context that owns an overridden API URL", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      url: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(context, "findContextByUrl").mockImplementation(async (url) => {
      if (url === "https://custom.lobu.ai/api/v1") {
        return {
          name: "custom",
          url: "https://custom.lobu.ai/api/v1",
          source: "config",
        };
      }
      return undefined;
    });
    spyOn(credentials, "getToken").mockImplementation(async (name) => {
      if (name === "custom") return "custom-token";
      if (name === "default") return "default-token";
      return null;
    });
    spyOn(context, "getActiveOrg").mockResolvedValue("my-org");

    const resolved = await resolveApiClient({
      apiUrl: "https://custom.lobu.ai/api/v1",
    });
    expect(resolved.contextName).toBe("custom");
    expect(resolved.token).toBe("custom-token");
    expect(resolved.apiBaseUrl).toBe("https://custom.lobu.ai");

    await expect(
      resolveApiClient({ apiUrl: "https://unknown.lobu.ai/api/v1" })
    ).rejects.toThrow("Refusing to send stored context credentials");
  });

  test("reads the active org from the resolved context", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(credentials, "getToken").mockResolvedValue("prod-token");
    const getActiveOrgSpy = spyOn(context, "getActiveOrg").mockImplementation(
      async (ctx) => {
        if (ctx === "prod") return "prod-org";
        return "default-org";
      }
    );

    const resolved = await resolveApiClient({ context: "prod" });

    expect(resolved.orgSlug).toBe("prod-org");
    expect(getActiveOrgSpy).toHaveBeenCalledWith("prod");
  });

  test("listOrganizations refuses unmatched URL overrides with stored credentials", async () => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "default",
      url: "https://app.lobu.ai/api/v1",
      source: "default",
    });
    spyOn(context, "findContextByUrl").mockResolvedValue(undefined);
    spyOn(credentials, "getToken").mockResolvedValue("default-token");

    await expect(
      listOrganizations({ apiUrl: "https://unknown.lobu.ai/api/v1" })
    ).rejects.toThrow("Refusing to send stored context credentials");
  });

  test.each([
    "local-session-token",
    "owl_pat_local",
  ])("resolves workspaces via /oauth/userinfo for %s without stored OAuth discovery", async (token) => {
    spyOn(context, "resolveContext").mockResolvedValue({
      name: "local",
      url: "http://127.0.0.1:8795/api/v1",
      source: "config",
    });
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);
    spyOn(credentials, "getToken").mockResolvedValue(token);
    spyOn(credentials, "loadCredentials").mockResolvedValue({
      accessToken: token,
      localWorkerToken: "owl_pat_local",
    });

    const fetchMock = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe("http://127.0.0.1:8795/oauth/userinfo");
        expect(init?.headers).toMatchObject({
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        });
        return new Response(
          JSON.stringify({
            sub: "user_1",
            email: "dev@example.com",
            organization_slug: "local-personal",
            personal_org_slug: "local-personal",
            organizations: [
              {
                id: "org_1",
                slug: "local-personal",
                name: "Local Personal",
                personal: true,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    ) as unknown as typeof fetch;

    const orgs = await listOrganizations({
      context: "local",
      fetchImpl: fetchMock,
    });
    expect(orgs).toEqual([
      { slug: "local-personal", name: "Local Personal", personal: true },
    ]);

    const resolved = await resolveApiClient({
      context: "local",
      fetchImpl: fetchMock,
    });
    expect(resolved.orgSlug).toBe("local-personal");
  });
});
