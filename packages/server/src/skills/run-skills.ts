import { RUN_SKILLS_MAX, SKILL_CONTENT_MAX_CHARS } from "@lobu/core/agent-tooling";
import { parseAutomationSkillSnapshots } from "../automations/skill-snapshots";

/** One skill a run receives: its directory name and its `SKILL.md` body. */
export interface RunSkill {
	name: string;
	content: string;
}

/**
 * Where a run's skills come from. Every delivery lane (the isolate turn
 * producer, the device poll, and the external claim) resolves through
 * `resolveRunSkills`, so changing the source changes it for all of them.
 *
 * - `workspace_library`: the enabled workspace library skills that apply to
 *   the turn's principal (`resolveLibrarySkillsFor`), read for an ordinary
 *   chat turn.
 * - `automation_version`: the raw `automation_versions.skills` jsonb of the
 *   version a run is pinned to.
 */
export type RunSkillSource =
	| { kind: "workspace_library"; skills: readonly RunSkill[] }
	| { kind: "automation_version"; skills: unknown };

/**
 * The validated skill list a run receives.
 *
 * The two sources keep different semantics on purpose. A live library is
 * bounded: an oversized skill is skipped and the rest are capped (the library
 * already holds only valid names and non-empty bodies). A version's frozen copies passed the save constraints
 * when they were pinned, so they are never renamed or dropped; a snapshot
 * that no longer reads cleanly throws, and the caller fails the run rather
 * than executing with part of its instructions.
 */
export function resolveRunSkills(source: RunSkillSource): RunSkill[] {
	return source.kind === "workspace_library"
		? boundLibrarySkills(source.skills)
		: parseAutomationSkillSnapshots(source.skills).map((skill) => ({
				name: skill.name,
				content: skill.content,
			}));
}

function boundLibrarySkills(skills: readonly RunSkill[]): RunSkill[] {
	// An oversized skill is DROPPED, never truncated. A skill is authored
	// instructions, so slicing one mid-sentence would hand the model a
	// corrupted rule that reads as complete — worse than not seeding it,
	// and invisible at the point where the agent acts on it.
	return skills
		.filter((skill) => skill.content.length > 0 && skill.content.length <= SKILL_CONTENT_MAX_CHARS)
		.slice(0, RUN_SKILLS_MAX)
		.map((skill) => ({ name: skill.name, content: skill.content }));
}
