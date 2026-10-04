/**
 * Egress denials are part of the guardrail audit trail.
 *
 * Enforcement of the LLM egress judge stays in the http-proxy plane, but a
 * judge DENY must now emit a `guardrail-trip` event (stage `egress`) just like
 * a message-pipeline guardrail. This test drives the real `checkDomainAccess`
 * decision path with a judge that denies and asserts the audit row is written
 * with `stage: "egress"` and the judge's name. The DB is faked at the
 * `insertEvent` seam so no Postgres is required.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";
import * as insertEventModule from "../../utils/insert-event";

// Capture `insertEvent` calls instead of hitting Postgres. `recordGuardrailTrip`
// (the audit path) is the only consumer reached here.
//
// Use `spyOn` (restored in afterAll) rather than `mock.module`: this suite shares
// a process with every other gateway suite, and bun's `mock.module` is
// process-global and CANNOT be un-done by `mock.restore()`. A whole-module stub
// here previously leaked a no-op `insertEvent` (which returns undefined) into
// co-running suites like agent-history-routes and interaction-bridge-owner-approval
// that rely on the REAL insertEvent to persist and RETURN interaction rows —
// surfacing as order-dependent CI failures once the runner changed the test-file
// execution order. Spying only this one function keeps the rest of the module real.
const insertEventCalls: Array<Record<string, unknown>> = [];
const insertEventSpy = spyOn(
  insertEventModule,
  "insertEvent",
).mockImplementation((async (params: Record<string, unknown>) => {
  insertEventCalls.push(params);
  return undefined;
}) as unknown as typeof insertEventModule.insertEvent);

import { flushPendingGuardrailAudits } from "../guardrails/audit.js";
import type {
  PolicyStore,
  ResolvedJudgeRule,
} from "../permissions/policy-store.js";
import { EgressJudge } from "../proxy/egress-judge/judge.js";
import {
  __testOnly,
  type ResolvedNetworkConfig,
  resolveNetworkConfig,
  setProxyEgressJudge,
  setProxyPolicyStore,
} from "../proxy/http-proxy.js";
import type { JudgeClient, JudgeVerdict } from "../proxy/egress-judge/types.js";

class DenyClient implements JudgeClient {
  async judge(_args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    return { verdict: "deny", reason: "host not permitted by policy" };
  }
}

function policyStoreReturning(rule: ResolvedJudgeRule): PolicyStore {
  return { resolve: () => rule } as unknown as PolicyStore;
}

describe("egress judge deny → guardrail-trip audit", () => {
  // Complete-isolation config snapshot so the host is never globally allowed and
  // the decision falls through to the judge. Passed explicitly into each
  // checkDomainAccess call — no shared module state.
  let config: ResolvedNetworkConfig;

  const prevAllowed = process.env.WORKER_ALLOWED_DOMAINS;
  const prevDisallowed = process.env.WORKER_DISALLOWED_DOMAINS;

  beforeEach(() => {
    insertEventCalls.length = 0;
    process.env.WORKER_ALLOWED_DOMAINS = "";
    process.env.WORKER_DISALLOWED_DOMAINS = "";
    config = resolveNetworkConfig();
    __testOnly.reset();
  });

  afterEach(() => {
    // Restore the pre-suite env so the blank allow/deny settings can't leak into
    // later files in Bun's shared process and reintroduce order-dependence.
    if (prevAllowed === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
    else process.env.WORKER_ALLOWED_DOMAINS = prevAllowed;
    if (prevDisallowed === undefined) delete process.env.WORKER_DISALLOWED_DOMAINS;
    else process.env.WORKER_DISALLOWED_DOMAINS = prevDisallowed;
  });

  afterAll(() => {
    // Hand the REAL insertEvent back to every other gateway suite sharing this
    // Bun process, so its return value (the inserted row) is available to the
    // approval/history suites regardless of file execution order.
    insertEventSpy.mockRestore();
  });

  test("a judged-domain DENY records a guardrail-trip with stage egress", async () => {
    const rule: ResolvedJudgeRule = {
      judgeName: "repo-owner-only",
      policy: "allow only repos the user owns",
      policyHash: "policy-hash-1",
    };
    setProxyPolicyStore(policyStoreReturning(rule));
    setProxyEgressJudge(
      new EgressJudge({ client: new DenyClient(), resolveOrgDefaultModel: async () => "judge-test" })
    );

    const decision = await __testOnly.checkDomainAccess(
      config,
      "api.github.com",
      "agent-a",
      "org-1"
    );

    // Decision logic unchanged: judge deny → blocked.
    expect(decision.allowed).toBe(false);
    expect(decision.source).toBe("judge");
    expect(decision.judge?.verdict).toBe("deny");

    await flushPendingGuardrailAudits();

    expect(insertEventCalls.length).toBe(1);
    const event = insertEventCalls[0];
    expect(event?.semanticType).toBe("guardrail-trip");
    const metadata = event?.metadata as Record<string, unknown>;
    expect(metadata?.stage).toBe("egress");
    expect(metadata?.guardrail).toBe("repo-owner-only");
    const judgeMetadata = metadata?.guardrail_metadata as Record<
      string,
      unknown
    >;
    expect(judgeMetadata?.hostname).toBe("api.github.com");
    expect(judgeMetadata?.verdict).toBe("deny");
  });

  test("a judged-domain ALLOW records no guardrail-trip", async () => {
    const rule: ResolvedJudgeRule = {
      judgeName: "repo-owner-only",
      policy: "allow only repos the user owns",
      policyHash: "policy-hash-1",
    };
    setProxyPolicyStore(policyStoreReturning(rule));
    setProxyEgressJudge(
      new EgressJudge({
        client: {
          judge: async () => ({ verdict: "allow", reason: "ok" }),
        },
        resolveOrgDefaultModel: async () => "judge-test",
      })
    );

    const decision = await __testOnly.checkDomainAccess(
      config,
      "api.github.com",
      "agent-a",
      "org-1"
    );

    expect(decision.allowed).toBe(true);
    await flushPendingGuardrailAudits();
    expect(insertEventCalls.length).toBe(0);
  });
});
