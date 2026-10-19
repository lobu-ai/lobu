import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import type { EvidencePolicy } from "../external-social-evidence";
import {
  externalSocialPrompt,
  socialOwnerPrompt,
} from "../external-social.prompt";
import { externalSocialReaction } from "../external-social.reaction";

/** All live identifiers are explicit operator inputs. Preserve live instructions,
 * outputs, schedule, executor and device bindings; fail on a changed version. */
export async function configureExternalSocial(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  expectedVersion: number,
  policy: EvidencePolicy
) {
  const { automation: a } = (await client.automations.get({
    automation_id: automationId,
  })) as { automation: any };
  if (a.version !== expectedVersion)
    throw new Error(
      "Automation changed; inspect its new version before updating"
    );
  if (a.execution_config?.executor?.kind !== "external")
    throw new Error("Expected an external Automation");
  if (["claimed", "pending", "running"].includes(a.automation_run?.status))
    throw new Error("Wait for the active external window");
  const check = (result: any) => {
    if (result?.status === "pending_approval")
      throw new Error("Configuration awaits policy approval");
    return result;
  };
  const prompt = socialOwnerPrompt(a.prompt);
  // The claim response carries pinned reactions_guidance, but not prompt.
  // Keep generated code only there, alongside the owner instructions: a
  // worker must receive bindings and preflight together without another fetch.
  const guidanceMarker = "\n\nEXTERNAL SOCIAL WINDOW INSTRUCTIONS v1\n";
  const guidance = `${(a.reactions_guidance ?? "").split(guidanceMarker)[0]}${guidanceMarker}${externalSocialPrompt(prompt, policy)}`;
  const reaction = externalSocialReaction(policy);
  // setReactionScript is a separate existing mutation. Retry reconciles both
  // values; no scheduled/external processing mode is disabled or replaced.
  if (a.reaction_script !== reaction)
    check(
      await client.automations.setReactionScript({
        automation_id: automationId,
        reaction_script: reaction,
      })
    );
  const { automation: fresh } = (await client.automations.get({
    automation_id: automationId,
  })) as { automation: any };
  if (
    fresh.version !== expectedVersion ||
    ["claimed", "pending", "running"].includes(fresh.automation_run?.status)
  )
    throw new Error(
      "Automation changed during configuration; reconcile before creating a version"
    );
  if (a.prompt !== prompt || a.reactions_guidance !== guidance)
    check(
      await client.automations.createVersion({
        automation_id: automationId,
        name: a.automation_name,
        description: a.description,
        prompt,
        reactions_guidance: guidance,
        sources: a.sources,
        outputs: a.outputs,
        set_as_current: true,
        change_notes:
          "Preserve external execution and scope; verify source receipts and full-body reads before completion; report graph candidates as pending ingestion.",
      })
    );
  return client.automations.get({ automation_id: automationId });
}
