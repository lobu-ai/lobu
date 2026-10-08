import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import {
  productActivityPrompt,
  productActivitySources,
} from "../product-activity-digest.prompt";

function needsApproval(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "pending_approval"
  );
}

/** Selected-workspace SDK setup. The external MCP client owns the timer.
 * Keep this Automation out of broad `lobu apply --prune` operations.
 * Supply the raw sibling reaction source; no generated script is stored here.
 */
export async function configureProductActivityDigest(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  reactionScript: string
) {
  const current = (await client.automations.get({
    automation_id: automationId,
  })) as {
    automation: { slug: string; automation_run?: { status?: string } };
  };
  if (current.automation.slug !== "product-activity-digest")
    throw new Error("Expected the existing product-activity-digest Automation");
  const schedule = await client.automations.update({
    automation_id: automationId,
    triggers: [],
  });
  if (needsApproval(schedule)) return schedule;
  const refreshed = (await client.automations.get({
    automation_id: automationId,
  })) as typeof current;
  if (
    ["pending", "running", "claimed"].includes(
      refreshed.automation.automation_run?.status ?? ""
    )
  )
    throw new Error(
      "Schedule stopped; wait for the active digest run before reconfiguring"
    );
  const reaction = await client.automations.setReactionScript({
    automation_id: automationId,
    reaction_script: reactionScript,
  });
  if (needsApproval(reaction)) return reaction;
  const executor = await client.automations.update({
    automation_id: automationId,
    triggers: [],
    managed_agent_id: null,
    device_worker_id: null,
    agent_kind: null,
    execution_config: null,
  });
  if (needsApproval(executor)) return executor;
  return client.automations.createVersion({
    automation_id: automationId,
    prompt: productActivityPrompt,
    sources: productActivitySources,
    outputs: { digests: { event: "summary" } },
    name: "Lobu production activity digest",
    description:
      "External MCP analysis of product activity and production logs; notify only meaningful changes.",
    reactions_guidance:
      "Complete every window. Return digests: [] when nothing materially changed; otherwise one concise evidence-backed summary. The reaction owns delivery.",
    change_notes:
      "External MCP only; preserve checkpoint and delivery destination, remove unconditional script delivery.",
    set_as_current: true,
  });
}
