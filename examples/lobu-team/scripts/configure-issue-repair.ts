import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";

/** Existing contracts only. Caller supplies the settled, tested bundle and
 * explicit live tracker identity; no source reads or credentials are embedded. */
export async function configureIssueRepair(
  client: Pick<ClientSDK, "automations">,
  trackerId: string,
  expectedVersion: number,
  bundle: { reaction: string; prompt: string }
) {
  const { automation: tracker } = (await client.automations.get({
    automation_id: trackerId,
    page_size: 1,
  })) as { automation: any };
  if (tracker.slug !== "issue-tracker" || tracker.version !== expectedVersion)
    throw new Error(
      "Inspect the changed tracker before installing health detection"
    );
  if (
    ["pending", "claimed", "running"].includes(tracker.automation_run?.status)
  )
    throw new Error("Wait for the active tracker run before installing");
  const { automations } = (await client.automations.list({})) as {
    automations: any[];
  };
  const existing = automations.find((a) => a.slug === "issue-repair");
  if (existing) {
    const { automation: repair } = (await client.automations.get({
      automation_id: String(existing.automation_id),
      page_size: 1,
    })) as { automation: any };
    if (
      repair.prompt !== bundle.prompt ||
      repair.managed_agent_id ||
      repair.device_worker_id ||
      repair.agent_kind
    )
      throw new Error(
        "Issue repair changed; inspect its version before updating"
      );
  }
  const installed = await client.automations.setReactionScript({
    automation_id: trackerId,
    reaction_script: bundle.reaction,
  });
  if ((installed as any).status === "pending_approval")
    throw new Error("Tracker installation awaits policy approval");
  // No managed agent, device or legacy executor override: this is external
  // analysis under the existing execution contract, advertised as due activity.
  const repair = existing
    ? { automation_id: String(existing.automation_id), status: existing.status }
    : await client.automations.create({
        slug: "issue-repair",
        name: "Issue repair",
        description:
          "External clients diagnose and repair the shared issue queue, recording blockers and verified recovery.",
        prompt: bundle.prompt,
        reactions_guidance: bundle.prompt,
        triggers: [
          {
            kind: "schedule",
            cron: "*/15 * * * *",
            timezone: "UTC",
            execution: "window",
            skip_if_unchanged: false,
          },
        ],
        sources: [
          {
            name: "issues",
            context: true,
            query: `SELECT id, name, metadata FROM entities
      WHERE entity_type = 'issue' AND metadata->>'status' NOT IN ('resolved', 'ignored')
        AND metadata->>'kind' IN ('system', 'dependency')
      ORDER BY metadata->>'triaged_at' NULLS FIRST, id LIMIT 100`,
          },
        ],
      });
  return { tracker: installed, repair };
}
