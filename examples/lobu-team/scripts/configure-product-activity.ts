import type { AutomationTrigger } from "@lobu/core/contracts/tools/manage-automations";
import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { productActivityConfiguration } from "../product-activity-digest.prompt";

export interface AutomationReadback {
  automation: {
    slug: string;
    automation_name: string;
    version: number;
    managed_agent_id: string | null;
    device_worker_id: string | null;
    reaction_script?: string | null;
    agent_kind?: "pi" | "opencode" | "claude-code" | "codex" | "agy" | null;
    execution_config: unknown;
    delivery_target: unknown;
    triggers: AutomationTrigger[];
    automation_run?: { status: string };
  };
  pending_analysis?: { next_window?: { start: string; end: string } };
}

function needsApproval(result: unknown): boolean {
  return (
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "pending_approval"
  );
}

/** Migrate the external analyst in place; never change its executor or progress. */
export async function configureLiveProductActivityDigest(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  reactionScript: string,
  settings: Parameters<typeof productActivityConfiguration>[1],
  expectedVersion: number
) {
  const configuration = productActivityConfiguration(automationId, settings);
  const read = async () => {
    const result = (await client.automations.get({
      automation_id: automationId,
    })) as AutomationReadback;
    if (!("automation" in result))
      throw new Error("Expected an installed digest");
    return result.automation;
  };
  const current = await read();
  if (
    current.slug !== "product-activity-digest" ||
    current.version !== expectedVersion
  )
    throw new Error("Digest baseline changed; review before migration");
  if (
    current.managed_agent_id ||
    current.device_worker_id ||
    current.execution_config
  )
    throw new Error("Expected the existing unassigned external processor");
  const pause = await client.automations.update({
    automation_id: automationId,
    triggers: [],
  });
  if (needsApproval(pause)) return pause;
  const paused = await read();
  if (
    ["pending", "running", "claimed"].includes(
      paused.automation_run?.status ?? ""
    )
  )
    throw new Error("Schedule stopped; wait for the active digest run");
  if (paused.version !== expectedVersion)
    throw new Error("Digest version changed while stopping");
  const version = await client.automations.createVersion({
    automation_id: automationId,
    ...configuration,
    name: current.automation_name,
    description:
      "Live product-source analysis and ClickHouse logs with independent durable progress.",
    set_as_current: true,
  });
  if (needsApproval(version)) return version;
  const reaction = await client.automations.setReactionScript({
    automation_id: automationId,
    reaction_script: reactionScript,
  });
  if (needsApproval(reaction)) return reaction;
  return client.automations.update({
    automation_id: automationId,
    triggers: current.triggers,
  });
}

/** Selected-workspace native migration. Choose and verify the target before calling.
 * Keep this Automation out of broad `lobu apply --prune` operations.
 * Supply the raw sibling reaction source; no generated script is stored here.
 */
export async function configureProductActivityDigest(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  reactionScript: string,
  settings: Parameters<typeof productActivityConfiguration>[1],
  native: {
    managedAgentId: string;
    deviceWorkerId?: string;
    agentKind?: AutomationReadback["automation"]["agent_kind"];
    baseline: {
      version: number;
      execution_config: unknown;
      reaction_script: string | null;
      triggers: unknown;
      delivery_target: unknown;
      device_worker_id: string | null;
      agent_kind: string | null;
    };
  }
) {
  if (!native?.managedAgentId?.trim())
    throw new Error(
      "Select and verify the existing owning native agent before migration"
    );
  const configuration = productActivityConfiguration(automationId, settings);
  const current = (await client.automations.get({
    automation_id: automationId,
  })) as {
    automation: {
      slug: string;
      managed_agent_id?: string;
      automation_run?: { status?: string };
      version: number;
      execution_config: unknown;
      reaction_script?: string | null;
      triggers: unknown;
      delivery_target?: unknown;
      device_worker_id?: string | null;
      agent_kind?: string | null;
    };
  };
  if (current.automation.slug !== "product-activity-digest")
    throw new Error("Expected the existing product-activity-digest Automation");
  if (current.automation.managed_agent_id !== native.managedAgentId)
    throw new Error("Native migration must preserve the existing owning agent");
  // The caller must supply the reviewed readback, rather than silently replacing
  // a newer owner definition. Runtime cursors and health are not config pins.
  for (const [field, expected] of Object.entries(native.baseline)) {
    const actual = current.automation[field as keyof typeof current.automation];
    if (JSON.stringify(actual ?? null) !== JSON.stringify(expected ?? null))
      throw new Error(
        `Automation configuration changed at ${field}; read and review a fresh candidate`
      );
  }
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
  // Keep cadence stopped until the native definition is installed.
  const owner = await client.automations.update({
    automation_id: automationId,
    triggers: [],
    managed_agent_id: native.managedAgentId,
    device_worker_id: native.deviceWorkerId ?? null,
    agent_kind: native.agentKind ?? null,
    execution_config: null,
  });
  if (needsApproval(owner)) return owner;
  const version = await client.automations.createVersion({
    automation_id: automationId,
    ...configuration,
    name: "Lobu production activity digest",
    description:
      "Native analysis of product activity and ClickHouse logs with independent durable log progress; notify only meaningful changes.",
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
