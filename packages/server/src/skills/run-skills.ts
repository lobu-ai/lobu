import { skillDirectoryName } from "@lobu/core/agent-tooling";
import type { SkillConfig } from "@lobu/core";
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
 * - `agent_library`: the agent's live `skillsConfig.skills`, read for an
 *   ordinary chat turn.
 * - `automation_version`: the raw `automation_versions.skills` jsonb of the
 *   version a run is pinned to.
 */
export type RunSkillSource =
	| { kind: "agent_library"; skills: readonly SkillConfig[] | undefined }
	| { kind: "automation_version"; skills: unknown };

/**
 * Skill bounds, restating the worker contract's own caps so an oversized
 * library is bounded here rather than failing schema validation at the poll.
 * A skill over the bound is dropped whole; see `resolveAgentLibrarySkills`.
 * Kept as numbers because the server works in the envelope's TYPES, not its
 * runtime schema object.
 */
const RUN_SKILLS_MAX = 64;
const RUN_SKILL_CHARS = 64_000;

/**
 * The validated skill list a run receives.
 *
 * The two sources keep different semantics on purpose. A live library is
 * filtered: a disabled, empty, badly named or oversized skill is skipped and
 * the rest are capped. A version's frozen copies passed the save constraints
 * when they were pinned, so they are never renamed or dropped; a snapshot
 * that no longer reads cleanly throws, and the caller fails the run rather
 * than executing with part of its instructions.
 */
export function resolveRunSkills(source: RunSkillSource): RunSkill[] {
	return source.kind === "agent_library"
		? resolveAgentLibrarySkills(source.skills ?? [])
		: parseAutomationSkillSnapshots(source.skills);
}

function resolveAgentLibrarySkills(skills: readonly SkillConfig[]): RunSkill[] {
	return skills
		.filter((skill) => skill.enabled && skill.content)
		.map((skill) => ({ name: skill.name, content: skill.content! }))
		.flatMap((skill) => {
			// An oversized skill is DROPPED, never truncated. A skill is authored
			// instructions, so slicing one mid-sentence would hand the model a
			// corrupted rule that reads as complete — worse than not seeding it,
			// and invisible at the point where the agent acts on it.
			const name = skillDirectoryName(skill.name);
			if (!name || skill.content.length > RUN_SKILL_CHARS) return [];
			return [{ name, content: skill.content }];
		})
		.slice(0, RUN_SKILLS_MAX);
}
