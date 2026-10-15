/**
 * Unit contract for `buildSenderIdentity` — the connector-agnostic edge that
 * turns a raw inbound chat author into the normalized identity spec the core
 * resolver (`resolveSenderIdentity`) consumes. Pure (no DB): asserts the drop
 * rules that keep a malformed/bot/unknown-platform author from ever being
 * attributed, the exact spec shape per platform, and — enumerating the
 * chat-identity registry — that every registered platform's sender attributes
 * under that platform's own namespace, so a newly registered platform cannot
 * be missed here.
 */

import { describe, expect, test } from "bun:test";
import { GOOGLE_IDENTITY } from "@lobu/connectors/google-identity";
import { SLACK_IDENTITY } from "@lobu/connectors/slack-identity";
import { WHATSAPP_WEB_IDENTITY } from "@lobu/connectors/whatsapp-web-identity";
import { CHAT_USER_IDENTITIES } from "../../../lobu/stores/chat-identity-sources.js";
import { buildSenderIdentity } from "../sender-identity.js";

const TEAM = "T1ACME";
const USER = "U1ALICE";
/** A synthetic Google account id — the shape Google's OIDC `sub` uses. */
const GOOGLE_SUB = "100000000000000000001";
/** A synthetic WhatsApp phone JID in the connector's canonical form. */
const PHONE_JID = "15550000001@s.whatsapp.net";

describe("buildSenderIdentity", () => {
  test("a bot post never attributes (returns null)", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: TEAM, authorId: USER, isBot: true }),
    ).toBeNull();
  });

  test("an unknown platform has no enforced sender model (returns null)", () => {
    expect(
      buildSenderIdentity({ platform: "telegram", teamId: TEAM, authorId: USER, isBot: false }),
    ).toBeNull();
  });

  test("a team-less Slack author is dropped (no malformed, non-workspace-scoped key)", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: null, authorId: USER, isBot: false }),
    ).toBeNull();
  });

  test("a missing author id is dropped", () => {
    expect(
      buildSenderIdentity({ platform: "slack", teamId: TEAM, authorId: null, isBot: false }),
    ).toBeNull();
  });

  test("a valid non-bot Slack sender yields the team-scoped slack_user_id spec, minting a person", () => {
    const spec = buildSenderIdentity({
      platform: "slack",
      teamId: TEAM,
      authorId: USER,
      isBot: false,
    });
    expect(spec).not.toBeNull();
    expect(spec?.mintEntityType).toBe("person");
    expect(spec?.identities).toEqual([
      {
        namespace: SLACK_IDENTITY.USER_ID,
        // The exact team-scoped key the ACL sync / entity-link path store under.
        identifier: `${TEAM}:${USER}`,
        matchOnly: false,
        primary: false,
        // Org-scoped, and asserted rather than omitted: a Slack user id already
        // carries its workspace, so it names the same person through every
        // connection that observes it. Scoping it per connection would fork one
        // person into one entity per connection.
        scopeKey: null,
      },
    ]);
  });

  test("a valid Google Chat sender yields the bare google_user_id spec, minting a person", () => {
    const spec = buildSenderIdentity({
      platform: "gchat",
      teamId: null,
      // Exactly what the gchat adapter hands over: the `users/{id}` resource
      // name, and no team id — Google Chat events carry none.
      authorId: `users/${GOOGLE_SUB}`,
      isBot: false,
    });
    expect(spec).not.toBeNull();
    expect(spec?.mintEntityType).toBe("person");
    expect(spec?.identities).toEqual([
      {
        namespace: GOOGLE_IDENTITY.USER_ID,
        // The BARE account id — the key a Google sign-in stamps on the
        // `$member`, so a captured message and a sign-in meet on one key.
        identifier: GOOGLE_SUB,
        matchOnly: false,
        primary: false,
        scopeKey: null,
      },
    ]);
    // Google account ids are unique across all of Google: a team id, present
    // or not, changes nothing.
    expect(
      buildSenderIdentity({
        platform: "gchat",
        teamId: TEAM,
        authorId: `users/${GOOGLE_SUB}`,
        isBot: false,
      }),
    ).toEqual(spec);
  });

  test("a Google Chat app id or malformed sender id is dropped", () => {
    for (const authorId of ["users/app-not-a-person", "", null, undefined]) {
      expect(
        buildSenderIdentity({ platform: "gchat", teamId: null, authorId, isBot: false }),
      ).toBeNull();
    }
  });

  test("a valid WhatsApp Web sender yields the canonical whatsapp_user_jid spec, minting a person", () => {
    const spec = buildSenderIdentity({
      platform: "whatsapp.web",
      teamId: null,
      // The web client's `@c.us` spelling plus a device suffix: the same
      // person as the canonical phone JID.
      authorId: "15550000001:7@c.us",
      isBot: false,
    });
    expect(spec).not.toBeNull();
    expect(spec?.mintEntityType).toBe("person");
    expect(spec?.identities).toEqual([
      {
        namespace: WHATSAPP_WEB_IDENTITY.USER_JID,
        identifier: PHONE_JID,
        matchOnly: false,
        primary: false,
        scopeKey: null,
      },
    ]);
  });

  test("a WhatsApp group JID names a conversation, not a sender (dropped)", () => {
    expect(
      buildSenderIdentity({
        platform: "whatsapp.web",
        teamId: null,
        authorId: "120363000000000001@g.us",
        isBot: false,
      }),
    ).toBeNull();
  });

  test("the bare `whatsapp` Chat-SDK transport has no identity descriptor (returns null)", () => {
    // A different transport from `whatsapp.web`: no connector contributes a
    // descriptor for it, so even a well-formed JID must not attribute.
    expect(
      buildSenderIdentity({ platform: "whatsapp", teamId: null, authorId: PHONE_JID, isBot: false }),
    ).toBeNull();
  });
});

/**
 * Class-wide: the registry is the ONE source of a platform's namespace and key
 * shape, so every descriptor in it must drive this edge. A representative
 * author id per platform, in the form an inbound message carries it, is
 * declared here and pinned against the registry — a newly registered platform
 * fails the pin with a clear reason instead of silently going unattributed.
 */
describe("buildSenderIdentity over the chat-identity registry", () => {
  const SAMPLE_AUTHOR_ID: Record<string, string> = {
    slack: USER,
    gchat: `users/${GOOGLE_SUB}`,
    "whatsapp.web": PHONE_JID,
  };

  test("every registered platform has a sample author id for the invariants below", () => {
    expect(Object.keys(SAMPLE_AUTHOR_ID).sort()).toEqual(
      CHAT_USER_IDENTITIES.map((i) => i.platform).sort(),
    );
  });

  for (const identity of CHAT_USER_IDENTITIES) {
    test(`${identity.platform}: a well-formed sender attributes under the descriptor's namespace and key`, () => {
      const authorId = SAMPLE_AUTHOR_ID[identity.platform];
      const spec = buildSenderIdentity({
        platform: identity.platform,
        teamId: TEAM,
        authorId,
        isBot: false,
      });
      expect(spec).not.toBeNull();
      expect(spec?.mintEntityType).toBe("person");
      expect(spec?.identities).toEqual([
        {
          namespace: identity.namespace,
          // Byte-identical to the key the sender→user lookup and the login
          // writer build, so all three meet on one row.
          identifier: identity.buildUserKey(TEAM, authorId),
          matchOnly: false,
          primary: false,
          scopeKey: null,
        },
      ]);
    });

    test(`${identity.platform}: a bot post never attributes`, () => {
      expect(
        buildSenderIdentity({
          platform: identity.platform,
          teamId: TEAM,
          authorId: SAMPLE_AUTHOR_ID[identity.platform],
          isBot: true,
        }),
      ).toBeNull();
    });
  }
});
