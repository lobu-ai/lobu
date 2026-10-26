import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { contextListCommand } from "../commands/context";
import { runCli } from "../index";
import * as context from "../internal/context";
import * as credentials from "../internal/credentials";

describe("context list", () => {
  afterEach(() => {
    mock.restore();
  });

  test("--json reports stored credentials without validating or exposing them", async () => {
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "work",
      contexts: {
        work: { url: "https://app.lobu.example/api/v1" },
        side: { url: "https://app.lobu.example/api/v1" },
        local: { url: "http://localhost:8787" },
      },
    });
    spyOn(context, "getCurrentContextName").mockResolvedValue("work");
    spyOn(credentials, "loadCredentials").mockImplementation(async (name) =>
      name === "side"
        ? null
        : {
            accessToken: "secret-access-token",
            refreshToken: "secret-refresh",
            expiresAt: 1,
            oauth: {
              clientId: "test-client",
              tokenEndpoint: "https://issuer.example/token",
            },
          }
    );
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Listing contexts must not make network requests")
    );
    const writes: string[] = [];
    spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    await runCli(["node", "lobu", "context", "list", "--json"]);

    const output = writes.join("");
    expect(JSON.parse(output)).toEqual({
      current: "work",
      contexts: [
        {
          name: "work",
          url: "https://app.lobu.example/api/v1",
          current: true,
          loggedIn: true,
        },
        {
          name: "side",
          url: "https://app.lobu.example/api/v1",
          current: false,
          loggedIn: false,
        },
        {
          name: "local",
          url: "http://localhost:8787",
          current: false,
          loggedIn: true,
        },
      ],
    });
    expect(output).not.toContain("secret");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("plain output keeps the effective current marker without reading credentials", async () => {
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "work",
      contexts: {
        work: { url: "https://app.lobu.example/api/v1" },
        local: { url: "http://localhost:8787" },
      },
    });
    spyOn(context, "getCurrentContextName").mockResolvedValue("local");
    const loadCredentialsSpy = spyOn(
      credentials,
      "loadCredentials"
    ).mockResolvedValue(null);
    const logSpy = spyOn(console, "log").mockImplementation(() => undefined);

    await contextListCommand();

    const output = logSpy.mock.calls.map(([line]) => line).join("\n");
    expect(output).toContain("Lobu contexts");
    expect(output).toContain("work");
    expect(output).toMatch(/\*.* local/);
    expect(loadCredentialsSpy).not.toHaveBeenCalled();
  });
});
