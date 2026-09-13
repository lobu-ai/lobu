import { describe, expect, test } from "bun:test";
import { checkInstalledNativeModule } from "../doctor";

describe("doctor native dependency checks", () => {
  test("fails when an installed native module cannot load", () => {
    const check = checkInstalledNativeModule(
      "sharp",
      () => "/node_modules/sharp/package.json",
      () => {
        throw new Error("Cannot find module '../build/Release/sharp-linux-x64.node'");
      }
    );
    expect(check).toEqual({
      name: "native:sharp",
      status: "fail",
      detail:
        "installed but not loadable: Cannot find module '../build/Release/sharp-linux-x64.node'",
    });
  });

  test("passes when an installed native module loads", () => {
    expect(
      checkInstalledNativeModule(
        "sharp",
        () => "/node_modules/sharp/package.json",
        () => ({})
      )
    ).toEqual({ name: "native:sharp", status: "ok", detail: "loadable" });
  });

  test("skips a module that is not part of the distribution", () => {
    expect(
      checkInstalledNativeModule("sharp", () => {
        throw new Error("not installed");
      })
    ).toBeNull();
  });
});
