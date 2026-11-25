/**
 * Tool: manage_skills
 *
 * Reads of the workspace skill library. Library writes arrive with P3b.
 *
 * - list: the library, ordered by (sort_order, name), keyset-paginated
 * - get: one skill by id, or an unarchived skill by name
 *
 * Both are org-read and honor the `skill_config` `read` policy for agent,
 * Automation and app principals.
 */

import {
  GetSkillAction,
  ListSkillsAction,
  ManageSkillsResultSchema,
  ManageSkillsSchema,
  SKILLS_LIST_DEFAULT_LIMIT,
} from '@lobu/core/contracts/tools/manage-skills';
import { assertSkillConfigReadAllowed } from '../../authz/skill-config-access';
import { createDbClientFromEnv } from '../../db/client';
import { getWorkspaceSkill, listWorkspaceSkills } from '../../skills/workspace-skills';
import { ToolUserError } from '../../utils/errors';
import { requireOrgReadAccess } from '../../utils/organization-access';
import { action, defineActionTool } from './action-tool';

export { ManageSkillsResultSchema, ManageSkillsSchema };

const manageSkillsTool = defineActionTool('manage_skills', {
  list: action(ListSkillsAction, async (args, ctx, env) => {
    const sql = createDbClientFromEnv(env);
    await requireOrgReadAccess(sql, ctx);
    await assertSkillConfigReadAllowed(ctx);
    return listWorkspaceSkills(sql, ctx.organizationId, {
      includeArchived: args.include_archived ?? false,
      cursor: args.cursor,
      limit: args.limit ?? SKILLS_LIST_DEFAULT_LIMIT,
    });
  }),
  get: action(GetSkillAction, async (args, ctx, env) => {
    const sql = createDbClientFromEnv(env);
    await requireOrgReadAccess(sql, ctx);
    await assertSkillConfigReadAllowed(ctx);
    if ((args.id === undefined) === (args.name === undefined)) {
      throw new ToolUserError('Pass exactly one of id or name.', 422);
    }
    const key = args.id !== undefined ? { id: args.id } : { name: args.name as string };
    return { skill: await getWorkspaceSkill(sql, ctx.organizationId, key) };
  }),
});

export const manageSkills = manageSkillsTool.run;
