import {
	AUTOMATION_PINNED_SKILLS_MAX,
	AUTOMATION_PINNED_SKILLS_MAX_BYTES,
	SKILL_CONTENT_MAX_CHARS,
	skillDirectoryName,
} from "@lobu/core/agent-tooling";

/**
 * One frozen skill copy on an Automation version. Pins made from the
 * workspace library also record the library row (`skill_id`) and the
 * `revision` they copied, so drift is judged by identity rather than by name.
 * Historical pins carry only `{ name, content }` and stay valid.
 */
export interface AutomationSkillSnapshot {
	name: string;
	content: string;
	skill_id?: string;
	revision?: number;
}

/** The same non-library constraints apply at save and every durable dispatch. */
export function validateAutomationSkillSnapshots(
	skills: readonly AutomationSkillSnapshot[],
): string | null {
	if (skills.length > AUTOMATION_PINNED_SKILLS_MAX) {
		return `An Automation may pin at most ${AUTOMATION_PINNED_SKILLS_MAX} skills.`;
	}
	// Historical pins keep the looser directory-name grammar; new pins can only
	// name library skills, whose grammar is stricter.
	const invalidName = skills.find((skill) => skillDirectoryName(skill.name) !== skill.name);
	if (invalidName) {
		return `Skill "${invalidName.name}" cannot be pinned: use a directory name of 1–128 letters, numbers, ".", "_", or "-", excluding "." and "..".`;
	}
	const empty = skills.find((skill) => !skill.content.trim());
	if (empty) return `Skill "${empty.name}" cannot be pinned because its body is empty.`;
	const oversized = skills.find((skill) => skill.content.length > SKILL_CONTENT_MAX_CHARS);
	if (oversized) {
		return `Skill "${oversized.name}" cannot be pinned: its body is ${oversized.content.length} characters; the maximum is ${SKILL_CONTENT_MAX_CHARS}.`;
	}
	const totalBytes = skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, "utf8"), 0);
	if (totalBytes > AUTOMATION_PINNED_SKILLS_MAX_BYTES) {
		return `Pinned Automation skills contain ${totalBytes} bytes of text; the maximum is ${AUTOMATION_PINNED_SKILLS_MAX_BYTES} bytes.`;
	}
	const names = new Set<string>();
	for (const skill of skills) {
		if (names.has(skill.name)) {
			return `Skill "${skill.name}" is listed more than once. Each skill may be pinned once per Automation.`;
		}
		names.add(skill.name);
	}
	return null;
}

/**
 * Parse the durable jsonb representation used by run dispatch. Invalid rows
 * throw so callers fail the run rather than silently executing without skills.
 */
export function parseAutomationSkillSnapshots(
	value: unknown,
): AutomationSkillSnapshot[] {
	let parsed = value;
	if (typeof parsed === "string") {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			throw new Error("Automation version has malformed pinned skills");
		}
	}
	if (parsed == null) return [];
	if (!Array.isArray(parsed)) {
		throw new Error("Automation version has malformed pinned skills");
	}
	const skills = parsed.map((entry): AutomationSkillSnapshot => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.name !== "string" ||
			typeof entry.content !== "string" ||
			(entry.skill_id !== undefined && typeof entry.skill_id !== "string") ||
			(entry.revision !== undefined && !Number.isInteger(entry.revision))
		) {
			throw new Error("Automation version has malformed pinned skills");
		}
		return {
			name: entry.name,
			content: entry.content,
			...(entry.skill_id === undefined ? {} : { skill_id: entry.skill_id, revision: entry.revision }),
		};
	});
	const error = validateAutomationSkillSnapshots(skills);
	if (error) throw new Error(`Automation version has malformed pinned skills: ${error}`);
	return skills;
}
