import type { AutomationReadback } from "./configure-product-activity";
import type { ListAutomationsResult } from "@lobu/core/contracts/tools/manage-automations";
import { sourceWindow } from "../product-activity";
import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";

/** Explicit deployment inputs preserve the installed consumer's dedupe namespace. */
export function teamAlertsModule(
  source: string,
  settings: {
    teamGithub: string[];
    digestAutomationId: string;
    namespace: string;
    sourceConnection: string;
    legacyFeedId: number;
    signupCatchupStart: string;
    cutoverEnd: string;
  }
) {
  if (
    !settings.teamGithub.length ||
    settings.teamGithub.some((name) => !/^[a-zA-Z0-9_-]{1,39}$/.test(name))
  )
    throw new Error("Expected explicit GitHub team logins");
  if (
    !/^[1-9][0-9]*$/.test(settings.digestAutomationId) ||
    !Number.isSafeInteger(Number(settings.digestAutomationId))
  )
    throw new Error("Expected a numeric digest Automation id");
  if (
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(settings.namespace) ||
    !/^[a-z0-9][a-z0-9-]{0,99}$/.test(settings.sourceConnection)
  )
    throw new Error("Expected explicit namespace and connection slug");
  if (
    !Number.isSafeInteger(settings.legacyFeedId) ||
    settings.legacyFeedId <= 0
  )
    throw new Error("Expected the retired feed's notification origin prefix");
  sourceWindow(settings.signupCatchupStart, settings.cutoverEnd);
  const marker = JSON.stringify("__TEAM_ALERTS_CONFIG__");
  if (source.split(marker).length !== 2)
    throw new Error("Expected the unconfigured team alerts module");
  return source.replace(marker, JSON.stringify(JSON.stringify(settings)));
}

/** Preserve the installed owner's permissions, delivery, mark and dedupe history. */
export async function configureTeamAlerts(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  source: string,
  settings: Parameters<typeof teamAlertsModule>[1],
  baseline: {
    version: number;
    owner: string;
    execution_config: unknown;
    delivery_target: unknown;
    triggers: unknown;
  }
) {
  const module = teamAlertsModule(source, settings);
  const read = async () =>
    (await client.automations.get({
      automation_id: automationId,
    })) as AutomationReadback;
  const current = await read();
  const check = (result: typeof current) => {
    const a = result.automation;
    if (
      a.slug !== "github-external-activity-alert" ||
      a.version !== baseline.version ||
      !baseline.owner ||
      a.managed_agent_id !== baseline.owner ||
      a.device_worker_id ||
      a.agent_kind ||
      JSON.stringify(a.execution_config ?? null) !==
        JSON.stringify(baseline.execution_config) ||
      JSON.stringify(a.delivery_target ?? null) !==
        JSON.stringify(baseline.delivery_target)
    )
      throw new Error("Team alerts baseline changed; review before migration");
  };
  check(current);
  if (
    JSON.stringify(current.automation.triggers) !==
    JSON.stringify(baseline.triggers)
  )
    throw new Error("Team alerts cadence changed; review before migration");
  const approval = (result: unknown) =>
    typeof result === "object" &&
    result !== null &&
    "status" in result &&
    result.status === "pending_approval";
  const pause = await client.automations.update({
    automation_id: automationId,
    triggers: [],
  });
  if (approval(pause)) return pause;
  const paused = await read();
  check(paused);
  if (
    ["pending", "running", "claimed"].includes(
      paused.automation.automation_run?.status ?? ""
    )
  )
    throw new Error("Schedule stopped; wait for the active team alert run");
  const start = paused.pending_analysis?.next_window?.start;
  if (
    !start ||
    !Number.isFinite(Date.parse(start)) ||
    Date.parse(start) >= Date.parse(settings.cutoverEnd)
  )
    throw new Error(
      "Schedule stopped; cutover must include the next arrival mark"
    );
  try {
    const reaction = await client.automations.setReactionScript({
      automation_id: automationId,
      reaction_script: module,
    });
    if (approval(reaction)) return reaction;
    const version = await client.automations.createVersion({
      automation_id: automationId,
      name: paused.automation.automation_name,
      prompt: "",
      skills: [],
      outputs: null,
      sources: [
        {
          name: "clock",
          context: true,
          query: "SELECT CURRENT_TIMESTAMP AS observed_at",
        },
      ],
      description:
        "Deterministic team alerts using live signups, GitHub arrivals and checked log counters.",
      set_as_current: true,
    });
    if (approval(version)) return version;
    const executor = await client.automations.update({
      automation_id: automationId,
      execution_config: null,
    });
    if (approval(executor)) return executor;
    const installed = await read();
    const details = (await client.automations.list({
      automation_id: automationId,
      include_details: true,
    })) as ListAutomationsResult;
    const installedVersion = details.automations.find(
      (automation) => String(automation.automation_id) === automationId
    );
    if (
      installed.automation.execution_config !== null ||
      installed.automation.reaction_script !== module ||
      !installedVersion ||
      installedVersion.prompt !== "" ||
      !Array.isArray(installedVersion.skills) ||
      installedVersion.skills.length !== 0 ||
      (installedVersion.outputs != null &&
        (typeof installedVersion.outputs !== "object" ||
          Object.keys(installedVersion.outputs).length !== 0))
    )
      throw new Error(
        "Installed team alerts did not match the code-only module"
      );
    return client.automations.update({
      automation_id: automationId,
      triggers: current.automation.triggers,
    });
  } catch (error) {
    throw new Error(
      "Team alerts migration failed with schedule stopped; repair before restoring cadence",
      { cause: error }
    );
  }
}
