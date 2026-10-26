import { defineEntityType, field, Type } from "@lobu/cli/config";

export const person = defineEntityType({
  key: "person",
  name: "Person",
  description:
    "A real-world person linked across connectors via identities (x_user_id, x_handle, wa_jid, phone, email, linkedin_slug, …). Metadata holds connector traits and optional human notes — not a CRM form.",
  metadata: { icon: "user", color: "#8B5CF6" },
  // Source observations do not automatically verify people. Existing person
  // identity candidates always require review, including contact-field matches.
  resolutionPolicy: {
    rules: [
      { fields: ["email"], normalizer: "email", onMatch: "review" },
      { fields: ["phone"], normalizer: "phone", onMatch: "review" },
      { fields: ["linkedin_url"], normalizer: "exact", onMatch: "review" },
      { fields: ["linkedin_slug"], normalizer: "exact", onMatch: "review" },
    ],
  },
  // Trait names must match connector EventAttributionRule.traits keys.
  // Identity join keys live on entity identities/aliases, not as required props.
  properties: {
    x_user_id: field("X user ID", { optional: true }),
    linkedin_member_id: field("LinkedIn member ID", { optional: true }),
    linkedin_slug: field("LinkedIn slug", { optional: true }),
    phone: field("Phone", { optional: true }),
    wa_jid: field("WhatsApp JID", { optional: true }),
    x_handle: field("X", {
      description:
        "X/Twitter @handle without @. Mutable secondary identity; primary join is x_user_id.",
      optional: true,
    }),
    x_display_name: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Display name from X profile/posts.",
      })
    ),
    last_x_interaction_at: field("Last X", {
      format: "date-time",
      description:
        "Most recent X post/like/bookmark/reply involving this person.",
      optional: true,
    }),
    last_x_dm_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent X DM with this person.",
      })
    ),
    push_name: field("WA name", {
      description: "WhatsApp push name.",
      optional: true,
    }),
    last_seen_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent WhatsApp message time for this contact.",
      })
    ),
    linkedin_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        description:
          "LinkedIn profile URL (display trait; identity is linkedin_slug).",
      })
    ),
    position: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "LinkedIn headline/position.",
      })
    ),
    company: field("Company", {
      description:
        "Employer name as seen (LinkedIn connection + manual). Canonical identity lives in the market org's public company entity; prefer its domain or slug when known.",
      optional: true,
    }),
    last_linkedin_message_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent LinkedIn message with this person.",
      })
    ),
    ig_username: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Instagram username.",
      })
    ),
    instagram_profile_url: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Instagram profile URL.",
      })
    ),
    from_name: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Name as seen on inbound email.",
      })
    ),
    last_email_at: Type.Optional(
      Type.Unsafe({
        type: "string",
        format: "date-time",
        description: "Most recent email from/to this address.",
      })
    ),
    email: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Email address (also an identity namespace).",
      })
    ),
    first_name: Type.Optional(Type.Unsafe({ type: "string" })),
    last_name: Type.Optional(Type.Unsafe({ type: "string" })),
    role: Type.Optional(
      Type.Unsafe({
        type: "string",
        description: "Freeform role or relationship note (not a CRM enum).",
      })
    ),
  },
  // WhatsApp + X identity metrics. Declared here so `apply` preserves them
  // rather than pruning — persons alias connector identities (wa_jid, x_handle).
  eventSets: {
    wa_messages: {
      by: "alias",
      field: "metadata->>'sender_jid'",
      against: "aliases",
      where: "connector_key='whatsapp.web'",
    },
    x_posts: {
      by: "alias",
      field: "metadata->>'author_handle'",
      against: "aliases",
      where:
        "connector_key='x' AND origin_type IN ('tweet','reply','liked_tweet','bookmark')",
    },
    x_dms: {
      by: "alias",
      field: "metadata->>'participant_handle'",
      against: "aliases",
      where: "connector_key='x' AND origin_type='dm_message'",
    },
  },
  measures: {
    messages_received: {
      eventSet: "wa_messages",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "WhatsApp messages received from this person.",
      tier: "silver",
    },
    x_posts_seen: {
      eventSet: "x_posts",
      agg: "count",
      description:
        "X posts involving this person as author (timeline, likes, bookmarks).",
      tier: "silver",
    },
    x_dms_received: {
      eventSet: "x_dms",
      agg: "count",
      where: "metadata->>'from_me'='false'",
      description: "Inbound X DMs with this person.",
      tier: "silver",
    },
  },
  dimensions: {
    chat: {
      expr: "metadata->>'chat_jid'",
      description: "WhatsApp chat the message belongs to.",
    },
  },
});
