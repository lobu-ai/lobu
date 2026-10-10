import { describe, expect, test } from "bun:test";
import config from "../lobu.config";

// Adopted connections must keep their declared auth bindings: the apply
// diff treats an omitted binding as an explicit clear (diff.ts compares
// `d.authProfileSlug ?? null` against the remote slug), and the server
// rejects clearing required authentication.
const BOUND = [
  {
    slug: "gmail-buremba",
    authProfile: "personal",
    appAuthProfile: "google-gmail-google-app",
  },
  {
    slug: "x-twitter-bu7emba",
    authProfile: "x-browser-account-2",
    appAuthProfile: undefined,
  },
  {
    slug: "spotify-buremba",
    authProfile: "spotify-spotify-account",
    appAuthProfile: "spotify-oauth-app",
  },
];

describe("adopted connection auth bindings", () => {
  test.each(BOUND)("$slug retains its selected auth bindings", ({
    slug,
    authProfile,
    appAuthProfile,
  }) => {
    const connection = (config.connections ?? []).find(
      (candidate) => candidate.slug === slug
    );
    expect(connection).toBeDefined();
    expect(connection?.authProfile).toMatchObject({ slug: authProfile });
    if (appAuthProfile) {
      expect(connection?.appAuthProfile).toMatchObject({
        slug: appAuthProfile,
      });
    } else {
      expect(connection?.appAuthProfile).toBeUndefined();
      expect(connection?.authProfile?.authKind).toBe("browser_session");
    }
  });

  test("every bound profile is declared with a matching kind", () => {
    const profiles = new Map(
      (config.authProfiles ?? []).map((profile) => [profile.slug, profile])
    );
    for (const { authProfile, appAuthProfile } of BOUND) {
      expect(profiles.get(authProfile)?.authKind).toBe(
        appAuthProfile ? "oauth_account" : "browser_session"
      );
      if (appAuthProfile) {
        expect(profiles.get(appAuthProfile)?.authKind).toBe("oauth_app");
      }
    }
  });
});
