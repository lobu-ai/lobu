import type { ClientSDK } from "../../../packages/server/src/sandbox/client-sdk";
import { socialResearchPrompt } from "../social-research.prompt";

/** Reuse the current X Automation and retain its source reader and checkpoint.
 * Keep cadence disabled until a real managed run and its reaction are verified.
 */
export async function configureSocialResearch(
  client: Pick<ClientSDK, "automations">,
  automationId: string,
  reactionScript: string,
  agentId: string
) {
  let { automation } = (await client.automations.get({
    automation_id: automationId,
  })) as {
    automation: {
      slug: string;
      prompt: string;
      automation_run?: { status?: string };
    };
  };
  if (automation.slug !== "x-market-scan")
    throw new Error("Expected the existing X market scan Automation");
  const script = automation.prompt.match(/```typescript\n([\s\S]*?)\n```/)?.[1];
  if (!script)
    throw new Error(
      "Existing X source reader is missing; do not replace it with a guessed reader"
    );
  // The existing reader returns its new_posts to the caller. Preserve the run
  // receipt as well so delivery can verify the exact URL and quote.
  const receiptReader = script.includes("read_run_id=r.run_id")
    ? script
    : script
        .replace("let data;", "let data; let read_run_id;")
        .replace(
          "data=r.output?.value;",
          "data=r.output?.value; read_run_id=r.run_id;"
        )
        .replace("return {account:", "return {read_run_id,account:");
  if (
    !receiptReader.includes("let read_run_id;") ||
    !receiptReader.includes("read_run_id=r.run_id") ||
    !receiptReader.includes("return {read_run_id,account:")
  )
    throw new Error("X reader shape changed; inspect it before updating");
  const check = (value: unknown) => {
    if ((value as { status?: string })?.status === "pending_approval")
      throw new Error("Social configuration is awaiting policy approval");
  };
  check(
    await client.automations.update({
      automation_id: automationId,
      triggers: [],
    })
  );
  ({ automation } = (await client.automations.get({
    automation_id: automationId,
  })) as { automation: typeof automation });
  if (
    ["running", "pending", "claimed"].includes(
      automation.automation_run?.status ?? ""
    )
  )
    throw new Error("Wait for the active social scan to finish");
  check(
    await client.automations.setReactionScript({
      automation_id: automationId,
      reaction_script: reactionScript,
    })
  );
  check(
    await client.automations.createVersion({
      automation_id: automationId,
      name: "Social research and engagement",
      description:
        "Read social inboxes and LinkedIn, X and TikTok posts individually, verify source evidence, and prepare replies for human submission.",
      prompt: socialResearchPrompt(
        `Existing X read script (run unchanged, retain read_run_id):\n\n\`\`\`typescript\n${receiptReader}\n\`\`\``
      ),
      sources: [
        {
          name: "run_context",
          query: "SELECT CURRENT_TIMESTAMP AS observed_at",
          context: true,
        },
      ],
      outputs: null,
      change_notes:
        "Include LinkedIn and TikTok inboxes in the same social run, with source-verified private cards and human-activated message drafts. Cadence stays disabled during live verification.",
      set_as_current: true,
    })
  );
  check(
    await client.automations.update({
      automation_id: automationId,
      managed_agent_id: agentId,
      device_worker_id: null,
      agent_kind: null,
      execution_config: {
        model: "openrouter/openai/gpt-5.4",
        effort: "medium",
      },
      triggers: [],
    })
  );
  return client.automations.get({ automation_id: automationId });
}
