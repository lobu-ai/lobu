/**
 * A poll refused with 409 `upgrade_required` (MIN_CLIENT_VERSION) can never
 * succeed on retry: the same binary sends the same version. The daemon must
 * stop and say so, not log a poll error every interval forever.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  WorkerClient,
  WorkerHttpError,
  WorkerUpgradeRequiredError,
} from "../daemon/client";
import { WorkerPollLoop } from "../daemon/poll-loop";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function respondToPoll(status: number, body: unknown): void {
  globalThis.fetch = (async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
}

function client(): WorkerClient {
  return new WorkerClient({
    apiUrl: "https://app.example.com",
    workerId: "headless:test-host",
    capabilities: {},
    platform: "headless",
    version: "19.2.0",
  });
}

describe("poll 409 upgrade_required", () => {
  test("the client surfaces the server's description as a typed error", async () => {
    respondToPoll(409, {
      error: "upgrade_required",
      error_description:
        "Update the headless worker to continue (this server requires a newer version)",
    });

    const error = await client().poll().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(WorkerUpgradeRequiredError);
    expect(error).toBeInstanceOf(WorkerHttpError);
    expect((error as WorkerUpgradeRequiredError).status).toBe(409);
    expect((error as WorkerUpgradeRequiredError).description).toBe(
      "Update the headless worker to continue (this server requires a newer version)",
    );
  });

  test("any other 409 stays a plain HTTP error", async () => {
    respondToPoll(409, { error: "conflict" });
    const error = await client().poll().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkerHttpError);
    expect(error).not.toBeInstanceOf(WorkerUpgradeRequiredError);
  });

  test("a non-JSON 409 body stays a plain HTTP error", async () => {
    respondToPoll(409, "upstream conflict");
    const error = await client().poll().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(WorkerHttpError);
    expect(error).not.toBeInstanceOf(WorkerUpgradeRequiredError);
  });

  test("the poll loop fails closed on the first refusal, credential mode or not", async () => {
    for (const failClosedOnPollAuthError of [false, true]) {
      let polls = 0;
      const loop = new WorkerPollLoop({
        client: {
          healthCheck: async () => true,
          poll: async () => {
            polls++;
            throw new WorkerUpgradeRequiredError("Update the headless worker to continue");
          },
        } as never,
        pollIntervalMs: 1,
        execute: async () => {},
        failClosedOnPollAuthError,
      });

      await expect(loop.start()).rejects.toBeInstanceOf(WorkerUpgradeRequiredError);
      expect(polls).toBe(1);
    }
  });
});
