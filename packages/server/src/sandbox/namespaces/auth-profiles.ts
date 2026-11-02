/**
 * ClientSDK `authProfiles` namespace. Thin wrapper over `manageAuthProfiles`.
 *
 * Field-name conventions mirror the handler schema exactly:
 *   - `create` takes an optional `slug` for the new profile (the handler
 *     auto-derives one from display_name if omitted).
 *   - `get`, `test`, `delete` look profiles up by `auth_profile_slug`.
 *   - `update` takes the existing `auth_profile_slug` plus an optional
 *     new `slug` if the caller wants to rename.
 *   - Credentials use `credentials` (key/value) or `auth_data` (OAuth/browser
 *     session state).
 */

import type {
	ManageAuthProfilesArgs,
	AuthProfileCreateInput,
	AuthProfileDeleteInput,
	AuthProfileListInput,
	AuthProfileUpdateInput,
} from "@lobu/core/contracts/tools/manage-auth-profiles";
import type { Env } from "../../index";
import { manageAuthProfiles } from "../../tools/admin/manage_auth_profiles";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller, idArg } from "./action-call";

export interface AuthProfilesNamespace {
	manage(input: ManageAuthProfilesArgs): Promise<unknown>;
	list(input?: AuthProfileListInput): Promise<unknown>;
	get(auth_profile_slug: string): Promise<unknown>;
	test(auth_profile_slug: string): Promise<unknown>;
	create(input: AuthProfileCreateInput): Promise<unknown>;
	update(input: AuthProfileUpdateInput): Promise<unknown>;
	delete(
		auth_profile_slug: string,
		options?: Omit<AuthProfileDeleteInput, "auth_profile_slug">,
	): Promise<unknown>;
}

export function buildAuthProfilesNamespace(
	ctx: ToolContext,
	env: Env,
): AuthProfilesNamespace {
	const { manage, method } = createActionCaller(
		manageAuthProfiles,
		env,
		ctx,
		"authProfiles",
	);

	return {
		manage,
		list: method("list_auth_profiles", { publicMethod: "list" }),
		get: method("get_auth_profile", {
			publicMethod: "get",
			mapArgs: (auth_profile_slug) => ({
				auth_profile_slug: idArg(
					"authProfiles.get",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
			}),
		}),
		test: method("test_auth_profile", {
			publicMethod: "test",
			mapArgs: (auth_profile_slug) => ({
				auth_profile_slug: idArg(
					"authProfiles.test",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
			}),
		}),
		create: method("create_auth_profile", { publicMethod: "create" }),
		update: method("update_auth_profile", { publicMethod: "update" }),
		delete: method("delete_auth_profile", {
			publicMethod: "delete",
			mapArgs: (auth_profile_slug, options) => ({
				auth_profile_slug: idArg(
					"authProfiles.delete",
					"auth_profile_slug",
					auth_profile_slug,
					"string",
				),
				...options,
			}),
		}),
	};
}
