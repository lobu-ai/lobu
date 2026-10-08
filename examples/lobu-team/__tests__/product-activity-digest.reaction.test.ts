import { describe, expect, mock, test } from "bun:test";
import type { ReactionClient, ReactionContext } from "@lobu/connector-sdk";
import Ajv from "ajv";
import reaction, { input } from "../product-activity-digest.reaction";

function harness(digests: Array<{ content: string }>, previous: string[] = []) {
  const send = mock(async () => ({
    event_id: 123,
    notified_count: 1,
    url: null,
  }));
  const query = mock(async (_sql: string) =>
    previous.map((payload_text) => ({ payload_text }))
  );
  const client = {
    query,
    notifications: { send },
  } as unknown as ReactionClient;
  const ctx = {
    extracted_data: { digests },
    window: { automation_id: 42, run_id: 77 },
  } as unknown as ReactionContext;
  return { send, query, run: () => reaction(ctx, client) };
}

describe("production digest delivery", () => {
  test("an uneventful check sends nothing", async () => {
    const h = harness([]);
    await h.run();
    expect(h.send).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  test("a new material finding uses the existing bound Automation delivery and retry key", async () => {
    const h = harness([
      { content: "A new user could not finish connecting their account." },
    ]);
    await h.run();
    expect(h.send).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "A new user could not finish connecting their account.",
        idempotency_key: "product-activity-digest:run:77",
        automation_source: { automation_id: 42, run_id: 77 },
      })
    );
  });

  test("the same accepted report stays quiet but a recovery can be sent", async () => {
    const repeated = harness(
      [{ content: "Connection unavailable." }],
      ["Connection unavailable."]
    );
    await repeated.run();
    expect(repeated.send).not.toHaveBeenCalled();
    expect(repeated.query.mock.calls[0][0]).toContain("provider_accepted");
    const recovery = harness(
      [{ content: "Connection recovered; the user's retry succeeded." }],
      ["Connection unavailable."]
    );
    await recovery.run();
    expect(recovery.send).toHaveBeenCalledTimes(1);
  });

  test("the declared output rejects multiple digests, empty bodies, and raw-sized payloads", () => {
    const validate = new Ajv().compile(input);
    expect(validate({ digests: [] })).toBe(true);
    for (const digests of [
      [{ content: "" }],
      [{ content: "x".repeat(3501) }],
      [{ content: "one" }, { content: "two" }],
    ]) {
      expect(validate({ digests })).toBe(false);
    }
  });
});
