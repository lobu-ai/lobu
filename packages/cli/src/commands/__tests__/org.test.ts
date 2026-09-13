import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as internal from "../../internal/index.js";
import { orgSetCommand } from "../org.js";

afterEach(() => mock.restore());

describe("orgSetCommand", () => {
  function context() {
    spyOn(internal, "resolveContext").mockResolvedValue({
      name: "cloud",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
  }

  test("sets an org returned for the current login", async () => {
    context();
    spyOn(internal, "listOrganizations").mockResolvedValue([
      { slug: "acme", name: "Acme" },
    ]);
    const set = spyOn(internal, "setActiveOrg").mockResolvedValue({} as never);
    await orgSetCommand("acme", { context: "cloud" });
    expect(set).toHaveBeenCalledWith("acme", "cloud");
  });

  test("rejects an arbitrary org slug that is not available", async () => {
    context();
    spyOn(internal, "listOrganizations").mockResolvedValue([
      { slug: "acme", name: "Acme" },
    ]);
    const set = spyOn(internal, "setActiveOrg").mockResolvedValue({} as never);
    await expect(orgSetCommand("made-up", { context: "cloud" })).rejects.toThrow(
      /not available.*acme/i
    );
    expect(set).not.toHaveBeenCalled();
  });

  test("requires login through listOrganizations", async () => {
    context();
    spyOn(internal, "listOrganizations").mockRejectedValue(
      new Error('Not logged in to context "cloud"')
    );
    await expect(orgSetCommand("acme", { context: "cloud" })).rejects.toThrow(
      /Not logged in/
    );
  });
});
