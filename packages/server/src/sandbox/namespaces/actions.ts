import type {
  ActionApplyInput,
  ActionGetInput,
  ActionPublishInput,
  ActionSetEnabledInput,
  ActionValidateInput,
} from "@lobu/core/contracts/tools/manage-actions";
import type { Env } from "../../index";
import { manageActions } from "../../tools/admin/manage_actions";
import type { ToolContext } from "../../tools/registry";
import { createActionCaller } from "./action-call";

export interface ActionsNamespace {
  list(): Promise<unknown>;
  get(input: ActionGetInput): Promise<unknown>;
  publish(input: ActionPublishInput): Promise<unknown>;
  setEnabled(input: ActionSetEnabledInput): Promise<unknown>;
  apply(input: ActionApplyInput): Promise<unknown>;
  validate(input: ActionValidateInput): Promise<unknown>;
}

export function buildActionsNamespace(ctx: ToolContext, env: Env): ActionsNamespace {
  const { method } = createActionCaller(manageActions, env, ctx, "actions");
  return {
    list: method("list"),
    get: method("get"),
    publish: method("publish"),
    setEnabled: method("set_enabled", { publicMethod: "setEnabled" }),
    apply: method("apply"),
    validate: method("validate"),
  };
}
