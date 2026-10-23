/**
 * Platform names arrive from a worker's poll body, so `PLATFORM_ALLOWLIST`
 * lookups must never resolve up the prototype chain.
 *
 * `"toString" in PLATFORM_ALLOWLIST` is `true`, so a bare `in` check made
 * `isKnownPlatform("toString")` pass. The connector-worker CLI validates
 * `--platform` with exactly that call, so the daemon would start and register,
 * and the server would then throw inside `authorizeCapabilities` — where the
 * inherited value is a function and `new Set(fn)` is not iterable.
 */

import { describe, expect, test } from "bun:test";
import { authorizeCapabilities, isKnownPlatform } from "../capabilities.js";

// Inherited keys present on every object literal.
const INHERITED_KEYS = [
  "toString",
  "constructor",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
];

describe("platform allowlist lookups ignore inherited keys", () => {
  test.each(INHERITED_KEYS)("isKnownPlatform(%p) is false", (key) => {
    expect(isKnownPlatform(key)).toBe(false);
  });

  test.each(
    INHERITED_KEYS
  )("authorizeCapabilities(%p) drops everything", (key) => {
    // Must return the empty/dropped shape rather than throwing: the server
    // calls this on every user-scoped poll, so a throw is a 500 on a request
    // whose input is entirely attacker-chosen.
    expect(() => authorizeCapabilities(key, ["os.files"])).not.toThrow();
    expect(authorizeCapabilities(key, ["os.files"])).toEqual({
      authorized: [],
      dropped: ["os.files"],
    });
  });

  test("a real platform still authorizes its own capabilities", () => {
    // Pins the fix as targeted — a blanket `return false` would satisfy every
    // assertion above while disabling device workers entirely.
    expect(isKnownPlatform("macos")).toBe(true);
    expect(authorizeCapabilities("macos", ["os.files"]).authorized).toContain(
      "os.files"
    );
    expect(
      authorizeCapabilities("macos", ["automations.execute"]).authorized
    ).toContain("automations.execute");
    expect(
      authorizeCapabilities("chrome-extension", ["browser.scripting"])
        .authorized
    ).toContain("browser.scripting");
  });

  test("headless devices authorize shell+files+automation execution but nothing browser-ish", () => {
    // A server/VM device (herdr) advertises the shell/files it actually has
    // plus `automations.execute` (the daemon runs local agent CLIs to complete
    // Automations); browser and UI capabilities must be dropped, never silently
    // granted.
    expect(isKnownPlatform("headless")).toBe(true);
    const authorized = authorizeCapabilities("headless", [
      "os.shell",
      "os.files",
      "automations.execute",
      "os.notifications",
      "browser.tabs",
      "computer_use",
    ]);
    expect(authorized.authorized.sort()).toEqual([
      "automations.execute",
      "os.files",
      "os.shell",
    ]);
    expect(authorized.dropped.sort()).toEqual([
      "browser.tabs",
      "computer_use",
      "os.notifications",
    ]);
  });

  test("released Mac clients retain their legacy audio capability", () => {
    expect(authorizeCapabilities("macos", ["system_audio"])).toEqual({
      authorized: ["system_audio"],
      dropped: [],
    });
    for (const platform of ["headless", "ios", "chrome-extension"]) {
      expect(authorizeCapabilities(platform, ["system_audio"])).toEqual({
        authorized: [],
        dropped: ["system_audio"],
      });
    }
  });
});
