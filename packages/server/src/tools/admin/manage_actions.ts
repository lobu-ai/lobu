import {
  ApplyActionAction,
  GetActionAction,
  ListActionsAction,
  ManageActionsResultSchema,
  ManageActionsSchema,
  PublishActionAction,
  SetActionEnabledAction,
  ValidateActionAction,
} from '@lobu/core/contracts/tools/manage-actions';
import type { Static } from '@sinclair/typebox';
import { randomUUID } from 'node:crypto';
import { applyAction } from '../../actions/executor';
import { getAction, listActions, publishAction, setActionEnabled } from '../../actions/registry';
import { getDb } from '../../db/client';
import { emit } from '../../events/emitter';
import type { Env } from '../../index';
import type { ToolContext } from '../registry';
import { action, defineActionTool } from './action-tool';

export { ManageActionsResultSchema, ManageActionsSchema };

const manageActionsTool = defineActionTool('manage_actions', {
  list: action(ListActionsAction, handleList),
  get: action(GetActionAction, handleGet),
  publish: action(PublishActionAction, handlePublish),
  set_enabled: action(SetActionEnabledAction, handleSetEnabled),
  apply: action(ApplyActionAction, handleApply),
  validate: action(ValidateActionAction, handleValidate),
});

export const manageActions = manageActionsTool.run;

async function handleList(_args: Static<typeof ListActionsAction>, ctx: ToolContext) {
  return { action: 'list' as const, actions: await listActions(getDb(), ctx) };
}

async function handleGet(args: Static<typeof GetActionAction>, ctx: ToolContext) {
  return { action: 'get' as const, ...await getAction(getDb(), ctx, args.key, args.version) };
}

async function handlePublish(args: Static<typeof PublishActionAction>, ctx: ToolContext) {
  const published = await publishAction(getDb(), ctx, args);
  emit(ctx.organizationId, { keys: [`action_type:${args.key}`] });
  return { action: 'publish' as const, ...published };
}

async function handleSetEnabled(args: Static<typeof SetActionEnabledAction>, ctx: ToolContext) {
  const actionType = await setActionEnabled(getDb(), ctx, args.key, args.enabled);
  emit(ctx.organizationId, { keys: [`action_type:${args.key}`] });
  return { action: 'set_enabled' as const, action_type: actionType };
}

async function handleApply(args: Static<typeof ApplyActionAction>, ctx: ToolContext, env: Env) {
  const { action: _action, ...input } = args;
  return applyAction(input, env, ctx);
}

async function handleValidate(args: Static<typeof ValidateActionAction>, ctx: ToolContext, env: Env) {
  const { action: _action, ...input } = args;
  return applyAction({ ...input, dry_run: true, idempotency_key: `validate:${randomUUID()}` }, env, ctx);
}
