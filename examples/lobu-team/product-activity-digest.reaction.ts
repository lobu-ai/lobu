import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";

export const input = {
  type: "object",
  properties: {
    digests: {
      type: "array",
      maxItems: 1,
      items: {
        type: "object",
        properties: {
          title: { type: "string", maxLength: 160 },
          content: { type: "string", minLength: 1, maxLength: 1000 },
          metadata: { type: "object" },
        },
        required: ["content"],
      },
    },
  },
  required: ["digests"],
  additionalProperties: false,
};

export default async (
  ctx: ReactionContext,
  client: ReactionClient
): Promise<void> => {
  const drafts = (
    ctx.extracted_data as {
      digests: Array<{ title?: string; content: string }>;
    }
  ).digests;
  const digest = drafts[0];
  if (!digest) return;
  // The notification validator counts UTF-16 units; JSON Schema counts code points.
  const body = digest.content.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, "");
  const automationId = Number(ctx.window.automation_id);
  if (!Number.isSafeInteger(automationId) || automationId <= 0)
    throw new Error("Invalid Automation ID");
  // The agent handles semantic novelty. This bounded check also catches an
  // identical report across windows; only an accepted delivery counts as seen.
  const previous = (await client.query(`
    SELECT payload_text FROM events
    WHERE automation_id = ${automationId}
      AND semantic_type = 'notification'
      AND created_at >= NOW() - INTERVAL '7 days'
      AND metadata @> '{"delivery":[{"platform":"slack","attempts":[{"status":"provider_accepted"}]}]}'::jsonb
    ORDER BY created_at DESC, id DESC LIMIT 10
  `)) as Array<{ payload_text?: string | null }>;
  if (previous.some((row) => row.payload_text?.trim() === body.trim())) return;
  await client.notifications.send({
    title: digest.title || "Lobu production",
    body,
    recipients: "admins",
    idempotency_key: `product-activity-digest:run:${ctx.window.run_id}`,
    automation_source: {
      automation_id: ctx.window.automation_id,
      run_id: ctx.window.run_id,
    },
  });
};
