import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { productActivityConfiguration } from "../product-activity-digest.prompt";

function needsApproval(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "pending_approval"
  );
}

/** Selected-workspace SDK setup. The Automation owns cadence; the external MCP client owns wakeups.
 * Keep this Automation out of broad `lobu apply --prune` operations.
 * Supply the raw sibling reaction source; no generated script is stored here.
 */
export async function configureProductActivityDigest(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  reactionScript: string,
  settings: Parameters<typeof productActivityConfiguration>[1]
) {
  const configuration = productActivityConfiguration(automationId, settings);
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
  // Bound Slack delivery uses the existing agent as its policy principal.
  // Keep cadence stopped until the version is installed; external mode prevents hosted dispatch.
  const executor = await client.automations.update({
    automation_id: automationId,
    triggers: [],
    device_worker_id: null,
    agent_kind: null,
    execution_config: { executor: { kind: "external" } },
  });
  if (needsApproval(executor)) return executor;
  const version = await client.automations.createVersion({
    automation_id: automationId,
    ...configuration,
    name: "Lobu production activity digest",
    description:
      "External MCP analysis of product activity and ClickHouse logs with independent durable log progress; notify only meaningful changes.",
    reactions_guidance:
      "Complete every product window with digests and log_progress arrays. Only verified contiguous ClickHouse windows advance log progress; quiet progress does not notify. The reaction owns delivery.",
    change_notes:
      "Use ClickHouse as the primary log source with keyed durable progress and bounded late-arrival rechecks; preserve the product arrival checkpoint and delivery destination.",
    set_as_current: true,
  });
  if (needsApproval(version)) return version;
  return client.automations.update({
    automation_id: automationId,
    triggers: [
      {
        kind: "schedule",
        cron: "*/20 * * * *",
        timezone: "UTC",
        skip_if_unchanged: false,
      },
    ],
  });
}
