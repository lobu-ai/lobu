/**
 * The MCP Skills extension (SEP-2640, `io.modelcontextprotocol/skills`):
 * `skills/list`, `skills/get` and `resources/read` of a skill's `SKILL.md`.
 *
 * Two kinds of skill are served. The bundled Lobu skill lives at
 * `skill://lobu/SKILL.md` (`skill://lobu` stays readable as an alias). Each
 * workspace library skill lives at `skill://<org-slug>/<name>/SKILL.md`.
 * A caller sees a library skill only when the workspace is reachable on this
 * connection, the caller is a workspace member, the `skill_config` read policy
 * admits the acting principal, the skill is enabled and one of its subjects
 * matches that principal. The same check answers list, get and read, so a skill
 * missing from the list is unknown to get and read as well.
 */
import { createHash } from "node:crypto";
import { isLibrarySkillName } from "@lobu/core/agent-tooling";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { listLiveGrantedMemberWorkspaces } from "../auth/oauth/workspace-grants";
import { hasRequiredMcpScope } from "../auth/tool-access";
import { skillConfigReader } from "../authz/skill-config-access";
import { getDb } from "../db/client";
import { resolveToolWorkspaceTarget } from "../sandbox/client-sdk";
import { requireWorkspaceContext } from "../tools/access-control";
import type { AccountToolContext, ToolContext } from "../tools/registry";
import { ToolUserError } from "../utils/errors";
import { getOrganizationSlug } from "../utils/url-builder";
import { LOBU_SKILL_FRONTMATTER, LOBU_SKILL_MARKDOWN } from "./lobu-skill.generated";
import { librarySkillsApplyingTo } from "./workspace-skills";

export const SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

const SKILL_SCHEME = "skill://";
const SKILL_FILE = "SKILL.md";
export const LOBU_SKILL_URI = `${SKILL_SCHEME}${LOBU_SKILL_FRONTMATTER.name}/${SKILL_FILE}`;
/** The bundled skill's original URI, still readable through `resources/read`. */
const LOBU_SKILL_ALIAS_URI = `${SKILL_SCHEME}${LOBU_SKILL_FRONTMATTER.name}`;

/** Entries per `skills/list` page. */
const SKILLS_PAGE_SIZE = 100;

export interface SkillEntry {
	uri: string;
	frontmatter: { name: string; description: string };
	resources: Array<{ uri: string; digest: string; size: number }>;
}

interface ServedSkill {
	entry: SkillEntry;
	markdown: string;
}

/**
 * A library skill's `SKILL.md`: YAML frontmatter carrying `name` and
 * `description`, then the stored content. Both values are written as JSON
 * strings, which are valid YAML double-quoted scalars, so they parse back to
 * the same strings: a name such as `null` or `123` stays a string and any
 * description text round-trips to the same `frontmatter.description`.
 */
export function renderLibrarySkillMarkdown(skill: { name: string; description: string; content: string }): string {
	return `---\nname: ${JSON.stringify(skill.name)}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content}`;
}

function servedSkill(uri: string, frontmatter: SkillEntry["frontmatter"], markdown: string): ServedSkill {
	const bytes = Buffer.from(markdown, "utf8");
	const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
	return { entry: { uri, frontmatter, resources: [{ uri, digest, size: bytes.byteLength }] }, markdown };
}

const LOBU_SKILL = servedSkill(LOBU_SKILL_URI, LOBU_SKILL_FRONTMATTER, LOBU_SKILL_MARKDOWN);

function unknownSkill(uri: string): McpError {
	return new McpError(ErrorCode.InvalidParams, `Unknown skill: ${uri}`);
}

/** `skill://<org-slug>/<name>/SKILL.md` split into its parts, or null for any other shape. */
function parseLibrarySkillUri(uri: string): { orgSlug: string; name: string } | null {
	if (!uri.startsWith(SKILL_SCHEME)) return null;
	const segments = uri.slice(SKILL_SCHEME.length).split("/");
	if (segments.length !== 3) return null;
	const [orgSlug, name, file] = segments as [string, string, string];
	if (!orgSlug || file !== SKILL_FILE || !isLibrarySkillName(name)) return null;
	return { orgSlug, name };
}

interface ReachableWorkspace {
	id: string;
	slug: string;
}

/**
 * The workspaces this connection may read skills from: its own workspace,
 * plus every live granted membership on an account connection. A caller
 * without the read scope reaches none.
 */
async function reachableWorkspaces(ctx: AccountToolContext): Promise<ReachableWorkspace[]> {
	if (!ctx.isAuthenticated || !hasRequiredMcpScope("read", ctx.scopes)) return [];
	const workspaces: ReachableWorkspace[] = [];
	if (ctx.organizationId) {
		const slug = await getOrganizationSlug(ctx.organizationId);
		if (slug) workspaces.push({ id: ctx.organizationId, slug });
	}
	if (ctx.allowCrossOrg && ctx.userId && Array.isArray(ctx.grantedOrganizationIds)) {
		const granted = await listLiveGrantedMemberWorkspaces({
			userId: ctx.userId,
			grantedOrganizationIds: ctx.grantedOrganizationIds,
		});
		for (const workspace of granted) {
			if (workspace.id !== ctx.organizationId) workspaces.push({ id: workspace.id, slug: workspace.slug });
		}
	}
	return workspaces;
}

/**
 * The library skills one workspace serves to this caller, in delivery order.
 * The workspace context comes from the same resolver every cross-workspace
 * tool call uses; a target it refuses serves nothing.
 */
async function workspaceSkills(ctx: AccountToolContext, workspace: ReachableWorkspace): Promise<ServedSkill[]> {
	let target: ToolContext;
	try {
		target = workspace.id === ctx.organizationId ? requireWorkspaceContext(ctx) : await resolveToolWorkspaceTarget(workspace.id, ctx);
	} catch (error) {
		if (error instanceof ToolUserError && error.httpStatus === 403) return [];
		throw error;
	}
	if (!target.memberRole) return [];
	const principal = await skillConfigReader(target);
	if (!principal) return [];
	const skills = await librarySkillsApplyingTo(getDb(), target.organizationId, principal, { enabledOnly: true });
	return skills.map((skill) =>
		servedSkill(
			`${SKILL_SCHEME}${workspace.slug}/${skill.name}/${SKILL_FILE}`,
			{ name: skill.name, description: skill.description },
			renderLibrarySkillMarkdown(skill),
		),
	);
}

/** Resolve a `SKILL.md` URI to the skill this caller is served, or throw -32602. */
async function resolveServedSkill(ctx: AccountToolContext, uri: string): Promise<ServedSkill> {
	if (uri === LOBU_SKILL_URI) return LOBU_SKILL;
	const parsed = parseLibrarySkillUri(uri);
	if (!parsed) throw unknownSkill(uri);
	const workspace = (await reachableWorkspaces(ctx)).find((candidate) => candidate.slug === parsed.orgSlug);
	if (!workspace) throw unknownSkill(uri);
	const skill = (await workspaceSkills(ctx, workspace)).find((served) => served.entry.uri === uri);
	if (!skill) throw unknownSkill(uri);
	return skill;
}

function decodeCursor(cursor: string): string {
	const after = Buffer.from(cursor, "base64url").toString("utf8");
	if (!after.startsWith(SKILL_SCHEME)) throw new McpError(ErrorCode.InvalidParams, "Invalid skills/list cursor.");
	return after;
}

/**
 * `skills/list`: the bundled skill plus every library skill served to this
 * caller, ordered by URI. The cursor is the last URI of the previous page, so
 * a skill added or removed between pages never shifts another off a page.
 */
export async function listSkills(
	ctx: AccountToolContext,
	cursor: string | undefined,
): Promise<{ resultType: "complete"; skills: SkillEntry[]; nextCursor?: string }> {
	const after = cursor === undefined ? null : decodeCursor(cursor);
	const served = [LOBU_SKILL];
	for (const workspace of await reachableWorkspaces(ctx)) served.push(...(await workspaceSkills(ctx, workspace)));
	const ordered = served
		.map((skill) => skill.entry)
		.filter((entry) => after === null || entry.uri > after)
		.sort((a, b) => (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0));
	const page = ordered.slice(0, SKILLS_PAGE_SIZE);
	const last = page.at(-1);
	return {
		resultType: "complete",
		skills: page,
		...(ordered.length > SKILLS_PAGE_SIZE && last ? { nextCursor: Buffer.from(last.uri, "utf8").toString("base64url") } : {}),
	};
}

/** `skills/get`: one skill's entry, or -32602 for a URI this caller is not served. */
export async function getSkill(ctx: AccountToolContext, uri: string): Promise<{ resultType: "complete"; skill: SkillEntry }> {
	return { resultType: "complete", skill: (await resolveServedSkill(ctx, uri)).entry };
}

/**
 * `resources/read` of a `skill://` URI: the exact bytes the entry's digest
 * covers. Returns null for any other scheme so the caller tries its other
 * resource kinds.
 */
export async function readSkillResource(
	ctx: AccountToolContext,
	uri: string,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> } | null> {
	if (!uri.startsWith(SKILL_SCHEME)) return null;
	const skill = uri === LOBU_SKILL_ALIAS_URI ? LOBU_SKILL : await resolveServedSkill(ctx, uri);
	return { contents: [{ uri, mimeType: "text/markdown", text: skill.markdown }] };
}

/** The bundled skill's `resources/list` entry. Library skills are discovered through `skills/list`. */
export const LOBU_SKILL_RESOURCE = {
	uri: LOBU_SKILL_URI,
	name: LOBU_SKILL_FRONTMATTER.name,
	description: LOBU_SKILL_FRONTMATTER.description,
	mimeType: "text/markdown",
};
