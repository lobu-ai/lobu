import { type Static, Type } from "@sinclair/typebox";
import type { ActionInput } from "./action-input";

// ============================================
// Schema
// ============================================

/**
 * The four caller-manageable kinds. The stored enum also has `interactive`,
 * which this contract deliberately omits: interactive-connection setup mints
 * those profiles itself.
 */
const AuthProfileKind = Type.Union([
  Type.Literal("env"),
  Type.Literal("oauth_app"),
  Type.Literal("oauth_account"),
  Type.Literal("browser_session"),
]);

export const ListAuthProfilesAction = Type.Object({
  action: Type.Literal("list_auth_profiles", {
    description: "List reusable auth profiles with filters.",
  }),
  connector_key: Type.Optional(
    Type.String({ description: "Filter by connector key" })
  ),
  provider: Type.Optional(
    Type.String({ description: 'Filter by OAuth provider (e.g. "google")' })
  ),
  profile_kind: Type.Optional(
    Type.Union(AuthProfileKind.anyOf, {
      description: "Filter by auth profile kind",
    })
  ),
});

export const GetAuthProfileAction = Type.Object({
  action: Type.Literal("get_auth_profile", {
    description: "Fetch one auth profile by slug.",
  }),
  auth_profile_slug: Type.String({ description: "Auth profile slug" }),
});

export const TestAuthProfileAction = Type.Object({
  action: Type.Literal("test_auth_profile", {
    description: "Probe an auth profile\u2019s credentials/token/cookies.",
  }),
  auth_profile_slug: Type.String({ description: "Auth profile slug" }),
});

export const CreateAuthProfileAction = Type.Object({
  action: Type.Literal("create_auth_profile", {
    description:
      "Create an auth profile; issues a connect URL for OAuth profiles.",
  }),
  connector_key: Type.Optional(
    Type.String({
      description:
        "Connector key (e.g. x, google.gmail). Required for env/oauth profiles; optional for browser_session (device-scoped resource).",
    })
  ),
  profile_kind: AuthProfileKind,
  display_name: Type.String({ description: "User-facing auth profile name" }),
  slug: Type.Optional(
    Type.String({
      description: "Stable public identifier for the auth profile",
    })
  ),
  credentials: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Schema-driven auth values for env or OAuth app profiles",
    })
  ),
  auth_data: Type.Optional(
    Type.Record(Type.String(), Type.Any(), {
      description: "Raw auth/session payload for browser-backed profiles",
    })
  ),
  app_auth_profile_slug: Type.Optional(
    Type.String({
      description:
        "OAuth app for account authorization. Members use the workspace default. Existing account grants cannot switch apps.",
    })
  ),
  requested_scopes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional OAuth scopes selected in addition to the connector required scopes.",
    })
  ),
});

export const UpdateAuthProfileAction = Type.Object({
  action: Type.Literal("update_auth_profile", {
    description:
      "Patch a profile; use reconnect to re-issue a connect token for OAuth.",
  }),
  auth_profile_slug: Type.String({ description: "Existing auth profile slug" }),
  display_name: Type.Optional(Type.String()),
  slug: Type.Optional(Type.String({ description: "New auth profile slug" })),
  credentials: Type.Optional(Type.Record(Type.String(), Type.String())),
  auth_data: Type.Optional(Type.Record(Type.String(), Type.Any())),
  app_auth_profile_slug: Type.Optional(
    Type.String({
      description:
        "OAuth app for account authorization. Members use the workspace default. Existing account grants cannot switch apps.",
    })
  ),
  requested_scopes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional OAuth scopes selected in addition to the connector required scopes.",
    })
  ),
  status: Type.Optional(
    Type.String({ description: "active, pending_auth, error, revoked" })
  ),
  reconnect: Type.Optional(
    Type.Boolean({
      description:
        "Re-issue a connect token for an oauth_account profile. Returns connect_url for re-authorization.",
    })
  ),
});

export const DeleteAuthProfileAction = Type.Object({
  action: Type.Literal("delete_auth_profile", {
    description:
      "Delete a profile; fails while active connections reference it unless force=true (force pauses dependents to pending_auth, it does not delete them).",
  }),
  auth_profile_slug: Type.String({
    description: "Auth profile slug to delete",
  }),
  force: Type.Optional(
    Type.Boolean({
      description:
        "Force delete even if active connections reference this profile",
    })
  ),
});

export const SetDefaultAuthProfileAction = Type.Object({
  action: Type.Literal("set_default_auth_profile", {
    description: "Pin/clear the org default OAuth-app profile for a connector.",
  }),
  connector_key: Type.String({
    description: "Connector key to pin the default for",
  }),
  auth_profile_slug: Type.Union([Type.String(), Type.Null()], {
    description:
      "OAuth app profile slug to pin as the org default, or null to clear.",
  }),
});

// ============================================
// Result Types
// ============================================

/**
 * Result of `manage_auth_profiles` — discriminated union (on `action`, plus an
 * error variant). TypeBox-first: `Static<>` derives the TS type from the same
 * schema exposed as the tool's `outputSchema`. Auth-profile rows are wide
 * snapshots (varied by connector), so they're honestly `Record<string, unknown>`.
 */
export const ManageAuthProfilesResultSchema = Type.Union([
  Type.Object({ error: Type.String() }),
  Type.Object({
    action: Type.Literal("list_auth_profiles"),
    auth_profiles: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  }),
  Type.Object({
    action: Type.Literal("get_auth_profile"),
    auth_profile: Type.Record(Type.String(), Type.Unknown()),
  }),
  Type.Object({
    action: Type.Literal("test_auth_profile"),
    status: Type.Union([
      Type.Literal("ok"),
      Type.Literal("warning"),
      Type.Literal("error"),
    ]),
    message: Type.String(),
    expires_at: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    cookie_count: Type.Optional(Type.Integer()),
    auth_cookie_name: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    is_expired: Type.Optional(Type.Boolean()),
    auth_mode: Type.Optional(
      Type.Union([Type.Literal("cookies"), Type.Literal("empty")])
    ),
  }),
  Type.Object({
    action: Type.Literal("create_auth_profile"),
    auth_profile: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    pending_slug: Type.Optional(Type.String()),
    connect_url: Type.Optional(Type.String()),
    connect_token: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("update_auth_profile"),
    auth_profile: Type.Record(Type.String(), Type.Unknown()),
    connect_url: Type.Optional(Type.String()),
    expires_at: Type.Optional(Type.String()),
  }),
  Type.Object({
    action: Type.Literal("delete_auth_profile"),
    deleted: Type.Literal(true),
    auth_profile_slug: Type.String(),
  }),
  Type.Object({
    action: Type.Literal("set_default_auth_profile"),
    connector_key: Type.String(),
    auth_profile: Type.Union([
      Type.Record(Type.String(), Type.Unknown()),
      Type.Null(),
    ]),
  }),
]);
export type ManageAuthProfilesResult = Static<
  typeof ManageAuthProfilesResultSchema
>;

export const ManageAuthProfilesSchema = Type.Union([
  ListAuthProfilesAction,
  GetAuthProfileAction,
  TestAuthProfileAction,
  CreateAuthProfileAction,
  UpdateAuthProfileAction,
  DeleteAuthProfileAction,
  SetDefaultAuthProfileAction,
]);

export type ManageAuthProfilesArgs = Static<typeof ManageAuthProfilesSchema>;

export type AuthProfileListInput = ActionInput<
  ManageAuthProfilesArgs,
  "list_auth_profiles"
>;
export type AuthProfileCreateInput = ActionInput<
  ManageAuthProfilesArgs,
  "create_auth_profile"
>;
export type AuthProfileUpdateInput = ActionInput<
  ManageAuthProfilesArgs,
  "update_auth_profile"
>;
export type AuthProfileDeleteInput = ActionInput<
  ManageAuthProfilesArgs,
  "delete_auth_profile"
>;
