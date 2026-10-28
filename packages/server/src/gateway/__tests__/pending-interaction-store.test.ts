/**
 * Tier B: claim atomicity, scoping, and sweep semantics for the PG-backed
 * pending-interaction store that backs the chat interaction bridge.
 *
 * The store backs the bridge's `Map<questionId, PendingQuestionEntry>`
 * with `public.pending_interactions`. Three properties matter:
 *   1. `claimPendingQuestion` is single-winner — two concurrent claims
 *      with matching scope return the payload exactly once.
 *   2. The scope tuple `(id, organization_id, connection_id,
 *      expected_user_id)` is enforced inside the SQL claim — mismatched
 *      org / connection / user clicks return null and DO NOT consume the
 *      row. These are the red→green checks that gate findings #1 (cross-
 *      tenant claim hole) and #3 (claim-then-auth race).
 *   3. `sweepStalePendingInteractions` only deletes rows older than the
 *      given max-age cutoff and returns the deleted ids so the bridge
 *      can sync its local SentMessage cache.
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from "./helpers/db-setup.js";
import { getDb } from "../../db/client.js";
import { registerInteractionBridge } from "../connections/interaction-bridge.js";
import {
  claimPendingQuestion,
  deletePendingQuestion,
  storePendingQuestion,
  sweepStalePendingInteractions,
} from "../connections/pending-interaction-store.js";
import { InteractionService, type PostedQuestion } from "../interactions.js";

const ORG_A = "org-a";
const ORG_B = "org-b";
const CONN_A = "conn-a";
const CONN_B = "conn-b";
const USER_A = "U_A";
const USER_B = "U_B";

async function seedOrg(id: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${id}, ${id}, ${id})
    ON CONFLICT (id) DO NOTHING
  `;
}

function buildQuestion(id: string, userId = USER_A): PostedQuestion {
  return {
    id,
    teamId: undefined,
    channelId: "C1",
    conversationId: "C1",
    userId,
    platform: "slack",
    question: "go?",
    options: ["yes", "no"],
  } as PostedQuestion;
}

describe("pending-interaction-store", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedOrg(ORG_B);
  });

  test("matching-scope claim returns the stored payload exactly once", async () => {
    const q = buildQuestion("q-1");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const first = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(first?.question.id).toBe("q-1");

    const second = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(second).toBeNull();
  });

  // Finding #1 — cross-tenant claim hole.
  //
  // Red on the previous commit: `claimPendingQuestion(id)` was keyed by
  // `id` only, so org B could consume org A's row by replaying the id.
  // Green here: scope by `organization_id` blocks the claim, AND the
  // row stays untouched so the rightful org can still claim it.
  test("cross-tenant claim is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-cross-tenant");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongOrg = await claimPendingQuestion(q.id, ORG_B, CONN_A, USER_A);
    expect(wrongOrg).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-cross-tenant");
  });

  test("cross-connection claim is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-cross-conn");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongConn = await claimPendingQuestion(q.id, ORG_A, CONN_B, USER_A);
    expect(wrongConn).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-cross-conn");
  });

  // Finding #3 — claim-then-auth race.
  //
  // Red on the previous commit: the handler did `claimQuestion(id)`
  // first, then compared `author.userId` against the row's userId, then
  // async-restashed on mismatch. A crash between claim and restash
  // permanently consumed the row until the 24h sweep.
  // Green here: `expected_user_id` is part of the SQL claim, so a wrong-
  // user click returns null without ever setting `claimed_at`. No
  // restash is needed because no claim happens.
  test("wrong-user click is rejected and does NOT consume the row", async () => {
    const q = buildQuestion("q-wrong-user", USER_A);
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const wrongUser = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_B);
    expect(wrongUser).toBeNull();

    const rightful = await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(rightful?.question.id).toBe("q-wrong-user");
  });

  test("sweep deletes only rows older than the cutoff and returns their ids", async () => {
    const sql = getDb();
    const fresh = buildQuestion("q-fresh");
    const stale = buildQuestion("q-stale");
    await storePendingQuestion(fresh.id, ORG_A, CONN_A, USER_A, {
      question: fresh,
    });
    await storePendingQuestion(stale.id, ORG_A, CONN_A, USER_A, {
      question: stale,
    });

    // Backdate one row past the 24h cutoff.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '48 hours'
       WHERE id = ${stale.id}
    `;

    const deletedIds = await sweepStalePendingInteractions();
    expect(deletedIds).toEqual(["q-stale"]);

    // Fresh row is still claimable; stale row is gone.
    expect(
      (await claimPendingQuestion(fresh.id, ORG_A, CONN_A, USER_A))?.question.id
    ).toBe("q-fresh");
    expect(
      await claimPendingQuestion(stale.id, ORG_A, CONN_A, USER_A)
    ).toBeNull();
  });
});

/**
 * Cleanup paths: a webhook retry must not reset the 24h TTL clock
 * (`created_at`), the sweep is bounded by its LIMIT so a large backlog drains
 * across cycles instead of locking the table, and the post-failure drop path
 * hard-deletes the row (scoped by org, connection and user) instead of leaving
 * a claimed row until the sweep.
 */
describe("pending-interaction-store cleanup paths", () => {
  beforeAll(async () => {
    await ensureDbForGatewayTests();
  });
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
  });

  // Fix #3 — ON CONFLICT no longer resets created_at.
  test("retry storePendingQuestion preserves the original created_at", async () => {
    const sql = getDb();
    const q = buildQuestion("q-retry");

    // First persist.
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });
    const initial = await sql<{ created_at: Date }>`
      SELECT created_at FROM pending_interactions WHERE id = ${q.id}
    `;
    const originalCreatedAt = new Date(initial[0]!.created_at).getTime();

    // Backdate the row so a "retry preserves created_at" assertion is
    // distinguishable from "row was just inserted now()". Without this the
    // pre/post-fix versions could both end up at now() within the same ms.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '1 hour'
       WHERE id = ${q.id}
    `;
    const backdated = await sql<{ created_at: Date }>`
      SELECT created_at FROM pending_interactions WHERE id = ${q.id}
    `;
    const backdatedTs = new Date(backdated[0]!.created_at).getTime();
    expect(backdatedTs).toBeLessThan(originalCreatedAt);

    // Webhook retry — same id, same scope, slightly different payload.
    const retry = { ...q, question: "go? (retry)" };
    await storePendingQuestion(retry.id, ORG_A, CONN_A, USER_A, {
      question: retry,
    });

    const after = await sql<{ created_at: Date; claimed_at: Date | null }>`
      SELECT created_at, claimed_at
      FROM pending_interactions WHERE id = ${q.id}
    `;
    const afterTs = new Date(after[0]!.created_at).getTime();

    // Pre-fix: this assertion fails — the ON CONFLICT clause moved
    // created_at to now() and `afterTs` ≈ now() ≫ `backdatedTs`.
    // Post-fix: created_at is unchanged across retries.
    expect(afterTs).toBe(backdatedTs);
    // claimed_at is still reset on conflict so a legitimate retry can
    // be claimed.
    expect(after[0]!.claimed_at).toBeNull();
  });

  // Fix #6 — bounded sweep.
  test("sweepStalePendingInteractions honours the LIMIT and remainder drains next cycle", async () => {
    const sql = getDb();
    const total = 25;
    for (let i = 0; i < total; i++) {
      const q = buildQuestion(`q-${i}`);
      await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });
    }
    // Backdate all rows past the cutoff.
    await sql`
      UPDATE pending_interactions
         SET created_at = now() - interval '48 hours'
    `;

    // First sweep caps at LIMIT=10.
    const first = await sweepStalePendingInteractions(
      24 * 60 * 60 * 1000,
      10
    );
    expect(first).toHaveLength(10);

    const remainingAfterFirst = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions
    `;
    expect(remainingAfterFirst[0]!.c).toBe(total - 10);

    // Second sweep drains the rest (LIMIT > remaining).
    const second = await sweepStalePendingInteractions(
      24 * 60 * 60 * 1000,
      100
    );
    expect(second).toHaveLength(total - 10);

    const remainingAfterSecond = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions
    `;
    expect(remainingAfterSecond[0]!.c).toBe(0);
  });

  // Fix #7 — drop-on-post-failure uses DELETE not claim.
  test("deletePendingQuestion hard-deletes the row, not claim-then-leave", async () => {
    const sql = getDb();
    const q = buildQuestion("q-drop");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    const beforeDrop = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(beforeDrop[0]!.c).toBe(1);

    const deleted = await deletePendingQuestion(q.id, ORG_A, CONN_A, USER_A);
    expect(deleted).toBe(true);

    // The whole row is gone. A subsequent claim sees no row.
    const afterDrop = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(afterDrop[0]!.c).toBe(0);
    expect(await claimPendingQuestion(q.id, ORG_A, CONN_A, USER_A)).toBeNull();
  });

  // Production-call-site test for Fix #7.
  //
  // The unit tests above prove `deletePendingQuestion` is correct in
  // isolation, but they would still pass if `registerInteractionBridge`
  // kept calling `claimPendingQuestion` on post failure. Drive the
  // bridge end-to-end here: emit `question:created`, force the thread
  // post to fail, then assert the row is gone (not just claimed_at-set).
  test("interaction-bridge: post-failure path DELETEs the pending row (not claim-only)", async () => {
    const sql = getDb();
    const connectionId = CONN_A;
    const questionId = "q-bridge-postfail";

    // Mocked ChatInstanceManager: `has` says yes, `getInstance` returns a
    // stub whose chat.channel() yields a thread whose .post() rejects —
    // forces the bridge into the post-failure branch in
    // `interaction-bridge.ts:onQuestionCreated`.
    const postSpy = {
      calls: 0,
      lastError: undefined as unknown,
    };
    const mockThread = {
      post: async () => {
        postSpy.calls += 1;
        const err = new Error("simulated post failure");
        postSpy.lastError = err;
        throw err;
      },
    };
    const mockChat = {
      channel: () => mockThread,
      // registerActionHandlers wires `chat.onAction(...)`. We don't care
      // about action dispatch for this test (we drive question:created
      // directly); just make it a no-op so registration succeeds.
      onAction: () => undefined,
    };
    const manager = {
      has: (id: string) => id === connectionId,
      getInstance: (id: string) =>
        id === connectionId
          ? {
              chat: mockChat,
              connection: {
                id: connectionId,
                platform: "slack",
                organizationId: ORG_A,
              },
            }
          : undefined,
    } as any;
    const connection = {
      id: connectionId,
      platform: "slack",
      organizationId: ORG_A,
    } as any;

    const interactionService = new InteractionService();
    const unregister = registerInteractionBridge(
      interactionService,
      manager,
      connection,
      mockChat as any
    );

    try {
      // Drive a question through the bridge. Use the bare emit (rather
      // than postQuestion) so the test doesn't depend on the public
      // factory's id-generation; we want a known id we can SELECT for.
      const event: PostedQuestion = {
        id: questionId,
        teamId: undefined,
        channelId: "C1",
        conversationId: "C1",
        userId: USER_A,
        connectionId,
        platform: "slack",
        question: "go?",
        options: ["yes", "no"],
      } as PostedQuestion;
      interactionService.emit("question:created", event);

      // The handler is async (store → post → fail →
      // delete). Wait for `thread.post` to be called first, then poll
      // for the row to disappear.
      const start = Date.now();
      while (postSpy.calls === 0 && Date.now() - start < 5000) {
        await new Promise((r) => setTimeout(r, 25));
      }
      let remaining = 1;
      while (Date.now() - start < 5000) {
        const rows = await sql<{ c: number }>`
          SELECT COUNT(*)::int AS c
          FROM pending_interactions WHERE id = ${questionId}
        `;
        remaining = rows[0]!.c;
        if (remaining === 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(postSpy.calls).toBeGreaterThan(0);
      // Row must be GONE — pre-fix, this assertion fails because
      // claimPendingQuestion only sets claimed_at and leaves the row.
      expect(remaining).toBe(0);
    } finally {
      unregister();
    }
  });

  // Scoping invariant of deletePendingQuestion — same safety as claim.
  test("deletePendingQuestion is scoped by (org, connection, user) — leaked id alone cannot delete", async () => {
    const sql = getDb();
    await seedOrg(ORG_B);
    const q = buildQuestion("q-scope");
    await storePendingQuestion(q.id, ORG_A, CONN_A, USER_A, { question: q });

    // Wrong org — no row deleted.
    expect(
      await deletePendingQuestion(q.id, "org-b", CONN_A, USER_A)
    ).toBe(false);
    // Wrong connection — no row deleted.
    expect(
      await deletePendingQuestion(q.id, ORG_A, "conn-other", USER_A)
    ).toBe(false);
    // Wrong user — no row deleted.
    expect(
      await deletePendingQuestion(q.id, ORG_A, CONN_A, "U_B")
    ).toBe(false);

    const stillThere = await sql<{ c: number }>`
      SELECT COUNT(*)::int AS c FROM pending_interactions WHERE id = ${q.id}
    `;
    expect(stillThere[0]!.c).toBe(1);

    // Correct scope — deletes.
    expect(
      await deletePendingQuestion(q.id, ORG_A, CONN_A, USER_A)
    ).toBe(true);
  });
});
