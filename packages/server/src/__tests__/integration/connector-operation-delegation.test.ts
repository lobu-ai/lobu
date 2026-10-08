import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { app } from '../../index';
import { DEVICE_MANIFESTS_BY_PLATFORM } from "@lobu/connector-worker/daemon/device-manifests";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertEntityApprovalPolicy } from "../../authz/entity-policy";
import { executeConnectorOperation } from "../../worker-api/execute-operation";
import { cleanupTestDatabase, getTestDb } from "../setup/test-db";
import {
  createTestAgent,
  createTestConnection,
  createTestConnectorDefinition,
  createTestUser,
  seedOwnerContext,
} from "../setup/test-fixtures";
import { handleExecute } from "../../tools/admin/manage_operations/handlers/execute";
import type { Env } from "../../index";
import { runShellBuiltin } from "../../../../connector-worker/src/daemon/builtins/os-shell";
import { post } from "../setup/test-helpers";

const sql = getTestDb();
const parentKey = "fixture.delegating";
const shellManifest = DEVICE_MANIFESTS_BY_PLATFORM.headless.find(
  (entry) => entry.key === "os.shell"
);
if (!shellManifest) throw new Error("Shipped shell manifest missing");
async function fixture() {
  const { org, user, ctx } = await seedOwnerContext();
  await sql`UPDATE organization SET metadata = ${sql.json({ personal_org_for_user_id: user.id })} WHERE id=${org.id}`;
  const agent = await createTestAgent({
    organizationId: org.id,
    ownerUserId: user.id,
  });
  const devices = [];
  for (const suffix of ["a", "b"]) {
    const worker = `fixture-shell-${suffix}`;
    const [device] =
      await sql`INSERT INTO device_workers(user_id,worker_id,platform,app_version,capabilities,organization_id,last_seen_at)
   VALUES(${user.id},${worker},'headless','9.9.0','["os.shell"]'::jsonb,${org.id},now()) RETURNING id`;
    const response = await post("/api/workers/poll", {
      body: {
        worker_id: worker,
        platform: "headless",
        app_version: "9.9.0",
        capabilities: { "os.shell": true },
        connector_manifests: [shellManifest],
        capacity_available: 0,
      },
    });
    expect(response.status).toBe(200);
    devices.push({ id: device.id, worker });
  }
  const [shell] =
    await sql`SELECT id FROM connections WHERE organization_id=${org.id} AND connector_key='os.shell' AND deleted_at IS NULL ORDER BY id LIMIT 1`;
  expect(shell).toBeDefined();
  await sql`UPDATE connections SET device_worker_id=${devices[0].id}::uuid WHERE id=${shell.id}`;
  await createTestConnectorDefinition({
    key: parentKey,
    name: "Delegating fixture",
    organization_id: org.id,
  });
  await sql`UPDATE connector_definitions SET actions_schema=${sql.json({ run: { name: "Run", kind: "write" } })} WHERE organization_id=${org.id} AND key=${parentKey}`;
  const connection = await createTestConnection({
    organization_id: org.id,
    connector_key: parentKey,
    created_by: user.id,
    createDefaultFeed: false,
  });
  await upsertEntityApprovalPolicy(org.id, {
    resourceClass: "connector_action",
    connectorKey: parentKey,
    effects: { execute: "auto" },
  });
  const [parent] =
    await sql`INSERT INTO runs(organization_id,connection_id,connector_key,connector_version,run_type,action_key,status,approval_status,
  claimed_by,claimed_at,last_heartbeat_at,created_by_user_id,policy_principal_kind,policy_principal_id)
  VALUES(${org.id},${connection.id},${parentKey},'1.0.0','action','run','running','auto','fixture-fleet',now(),now(),${user.id},'agent',${agent.agentId}) RETURNING id`;
  const request = {
    connection_id: Number(shell.id),
    operation_key: "run",
    input: { command: "printf delegation-proof", timeout_ms: 1000 },
    idempotency_key: "command",
    background: true,
  };
  const params = {
    parentRunId: Number(parent.id),
    claimedBy: "fixture-fleet",
    organizationId: org.id,
    request,
  };
  return { org, user, agent, devices, connection, params, ctx };
}

describe("connector delegation through the public operation lifecycle", () => {
  beforeEach(cleanupTestDatabase);
  it("preserves child Ask, requester, approval card and idempotent replay", async () => {
    const { params, org, agent } = await fixture();
    const result = await executeConnectorOperation(params);
    expect(result).toMatchObject({ status: "pending_approval" });
    if (!("run_id" in result)) throw new Error(JSON.stringify(result));
    expect(await executeConnectorOperation(params)).toMatchObject({
      run_id: result.run_id,
      status: "pending_approval",
    });
    const [run] =
      await sql`SELECT policy_principal_kind,policy_principal_id,parent_run_id,run_metadata FROM runs WHERE id=${result.run_id}`;
    expect(run).toMatchObject({
      policy_principal_kind: "agent",
      policy_principal_id: agent.agentId,
      parent_run_id: params.parentRunId,
    });
    expect(run.run_metadata.connector_parent_run_id).toBeUndefined();
    expect(
      await sql`SELECT id FROM events WHERE organization_id=${org.id} AND run_id=${result.run_id}`
    ).toHaveLength(1);
    await expect(
      executeConnectorOperation({
        ...params,
        request: { ...params.request, input: { command: "different" } },
      })
    ).rejects.toThrow(/idempotency/i);
  });
  it("enqueues only on the saved device and keeps that routing on replay", async () => {
    const { params, org, devices } = await fixture();
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: "connector_action",
      connectorKey: "os.shell",
      effects: { execute: "auto" },
    });
    const result = await executeConnectorOperation(params);
    expect(result).toMatchObject({ status: "in_progress" });
    if (!("run_id" in result)) throw new Error(JSON.stringify(result));
    const [run] =
      await sql`SELECT target_device_worker_id,status FROM runs WHERE id=${result.run_id}`;
    expect(run).toMatchObject({
      target_device_worker_id: devices[0].id,
      status: "pending",
    });
    await sql`UPDATE connections SET device_worker_id=${devices[1].id}::uuid WHERE id=${params.request.connection_id}`;
    expect(await executeConnectorOperation(params)).toMatchObject({
      run_id: result.run_id,
    });
    const [replayed] =
      await sql`SELECT target_device_worker_id FROM runs WHERE id=${result.run_id}`;
    expect(replayed.target_device_worker_id).toBe(devices[0].id);
  });
  it("blocks denied children without creating a run", async () => {
    const { params, org } = await fixture();
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: "connector_action",
      connectorKey: "os.shell",
      effects: { execute: "deny" },
    });
    expect(await executeConnectorOperation(params)).toMatchObject({
      error: expect.stringContaining("Policy blocks"),
    });
    expect(
      await sql`SELECT id FROM runs WHERE parent_run_id=${params.parentRunId}`
    ).toHaveLength(0);
  });
  it("denies foreign/private targets and cannot recurse into compiled connectors", async () => {
    const { params, org, connection } = await fixture();
    const stranger = await createTestUser();
    await sql`UPDATE connections SET visibility='private',created_by=${stranger.id} WHERE id=${params.request.connection_id}`;
    expect(await executeConnectorOperation(params)).toMatchObject({
      error: "Connection not found or not visible.",
    });
    expect(
      await executeConnectorOperation({
        ...params,
        request: { ...params.request, connection_id: connection.id },
      })
    ).toMatchObject({ error: expect.stringContaining("pinned native device") });
    await expect(
      executeConnectorOperation({
        ...params,
        organizationId: org.id + "-other",
      })
    ).rejects.toThrow(/live claim/);
  });
  it("rejects wrong claim, cancelled/expired parent and already aborted call", async () => {
    const { params } = await fixture();
    await expect(
      executeConnectorOperation({ ...params, claimedBy: "other-worker" })
    ).rejects.toThrow(/live claim/);
    await expect(
      executeConnectorOperation({ ...params, abortSignal: AbortSignal.abort() })
    ).rejects.toThrow(/live claim/);
    await sql`UPDATE runs SET expires_at=now()-interval '1 minute' WHERE id=${params.parentRunId}`;
    await expect(executeConnectorOperation(params)).rejects.toThrow(
      /live claim/
    );
    await sql`UPDATE runs SET expires_at=NULL,status='cancelled' WHERE id=${params.parentRunId}`;
    await expect(executeConnectorOperation(params)).rejects.toThrow(
      /live claim/
    );
  });
  it("refuses the native bridge for a browser device", async () => {
    const { params, devices } = await fixture();
    await sql`UPDATE device_workers SET platform='chrome-extension' WHERE id=${devices[0].id}::uuid`;
    expect(await executeConnectorOperation(params)).toMatchObject({
      error: expect.stringContaining("ctx.browser"),
    });
  });
  it("runs a real isolate parent through device claim, supervised shell and completion", async () => {
    const { params, org, agent, connection, ctx, devices } = await fixture();
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: "connector_action",
      connectorKey: "os.shell",
      effects: { execute: "auto" },
    });
    await sql`UPDATE connector_versions SET compiled_code=${`class Fixture {
   async sync(){return {items:[]};}
   async execute(ctx){return {success:true,output:await ctx.operations.execute(ctx.input)};}
  } module.exports={Fixture};`} WHERE connector_key=${parentKey}`;
    const resultPromise = handleExecute(
      {
        action: "execute",
        connection_id: connection.id,
        operation_key: "run",
        input: { ...params.request, background: false },
      },
      { ...ctx, agentId: agent.agentId },
      {} as Env
    );
    let childId = 0;
    await vi.waitFor(async () => {
      const [child] =
        await sql`SELECT id FROM runs WHERE connection_id=${params.request.connection_id} AND status='pending'`;
      expect(child).toBeDefined();
      childId = Number(child.id);
    });
    const poll = async (worker: string) =>
      post("/api/workers/poll", {
        body: {
          worker_id: worker,
          platform: "headless",
          app_version: "9.9.0",
          capabilities: { "os.shell": true },
          connector_manifests: [shellManifest],
          capacity_available: 1,
        },
      });
    const wrong = await (await poll(devices[1].worker)).json();
    expect(wrong.run_id).not.toBe(childId);
    const claim = await (await poll(devices[0].worker)).json();
    expect(claim.run_id).toBe(childId);
    const output = await runShellBuiltin(claim.action_input);
    expect(output.stdout).toBe("delegation-proof");
    const completed = await post("/api/workers/complete-action", {
      body: {
        run_id: childId,
        worker_id: devices[0].worker,
        status: "success",
        action_output: output,
      },
    });
    expect(completed.status).toBe(200);
    expect(await resultPromise).toMatchObject({
      status: "completed",
      output: {
        status: "completed",
        run_id: childId,
        output: { stdout: "delegation-proof", exit_code: 0 },
      },
    });
  });
  it("cancels a foreground child wait through the existing terminalization path", async () => {
    const { params, org } = await fixture();
    await upsertEntityApprovalPolicy(org.id, {
      resourceClass: "connector_action",
      connectorKey: "os.shell",
      effects: { execute: "auto" },
    });
    const controller = new AbortController();
    const pending = executeConnectorOperation({
      ...params,
      request: { ...params.request, background: false },
      abortSignal: controller.signal,
    });
    let childId = 0;
    await vi.waitFor(async () => {
      const [child] =
        await sql`SELECT id FROM runs WHERE parent_run_id=${params.parentRunId}`;
      expect(child).toBeDefined();
      childId = Number(child.id);
    });
    controller.abort();
    expect(await pending).toMatchObject({ status: "timeout", run_id: childId });
    const [child] = await sql`SELECT status FROM runs WHERE id=${childId}`;
    expect(child.status).toBe("timeout");
  });
  it("validates the worker wire contract before spending authority", async () => {
    const { params } = await fixture();
    const result = await post("/api/workers/execute-operation", {
      body: {
        parent_run_id: params.parentRunId,
        worker_id: params.claimedBy,
        request: { ...params.request, organization_id: "forged" },
      },
    });
    expect(result.status).toBe(400);
  });
  it("answers a lost parent claim with its typed status, not a 500", async () => {
    const { params } = await fixture();
    const result = await post("/api/workers/execute-operation", {
      body: {
        parent_run_id: params.parentRunId,
        worker_id: "other-worker",
        request: params.request,
      },
    });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({
      error: expect.stringContaining("live claim"),
    });
  });
  it('a fleet HTTP disconnect terminates the foreground child', async () => {
    const { params, org } = await fixture();
    await upsertEntityApprovalPolicy(org.id, { resourceClass: 'connector_action', connectorKey: 'os.shell', effects: { execute: 'auto' } });
    const server = serve({ port: 0, fetch: app.fetch });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test listener');
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}/api/workers/execute-operation`, {
      method: 'POST', headers: {'content-type':'application/json'}, signal: controller.signal,
      body: JSON.stringify({parent_run_id:params.parentRunId,worker_id:params.claimedBy,request:{...params.request,background:false}}),
    }).catch(error => error);
    try {
      await vi.waitFor(async () => {
        expect(await sql`SELECT id FROM runs WHERE parent_run_id=${params.parentRunId}`).toHaveLength(1);
      });
      controller.abort();
      expect(await response).toMatchObject({name:'AbortError'});
      await vi.waitFor(async () => {
        const [child] = await sql`SELECT status FROM runs WHERE parent_run_id=${params.parentRunId}`;
        expect(child.status).toBe('timeout');
      }, {timeout: 3000});
    } finally {
      controller.abort();
      await sql`UPDATE runs SET status='cancelled' WHERE parent_run_id=${params.parentRunId} AND status IN ('running','pending')`;
      server.closeAllConnections();
      server.close();
    }
  });
});
