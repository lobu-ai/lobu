import { skillDirectoryName } from "@lobu/core/agent-tooling";

export interface AutomationSkillSnapshot {
	name: string;
	content: string;
}

/** The same non-library constraints apply at save and every durable dispatch. */
export function validateAutomationSkillSnapshots(
	skills: readonly AutomationSkillSnapshot[],
): string | null {
	if (skills.length > 5) return "An Automation may pin at most 5 skills.";
	const invalidName = skills.find((skill) => skillDirectoryName(skill.name) !== skill.name);
	if (invalidName) {
		return `Skill "${invalidName.name}" cannot be pinned: use a directory name of 1–128 letters, numbers, ".", "_", or "-", excluding "." and "..".`;
	}
	const empty = skills.find((skill) => !skill.content.trim());
	if (empty) return `Skill "${empty.name}" cannot be pinned because its body is empty.`;
	const totalBytes = skills.reduce((sum, skill) => sum + Buffer.byteLength(skill.content, "utf8"), 0);
	if (totalBytes > 32 * 1024) {
		return `Pinned Automation skills contain ${totalBytes} bytes of text; the maximum is 32768 bytes (32KB).`;
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
	const skills = parsed.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.name !== "string" ||
			typeof entry.content !== "string"
		) {
			throw new Error("Automation version has malformed pinned skills");
		}
		return { name: entry.name, content: entry.content };
	});
	const error = validateAutomationSkillSnapshots(skills);
	if (error) throw new Error(`Automation version has malformed pinned skills: ${error}`);
	return skills;
}
