import { IsolateExecutor } from "@lobu/connector-worker/executor/isolate";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { compileConnectorSource } from "../../../utils/connector-compiler";

const request = {
  connection_id: 123,
  operation_key: "run",
  input: { command: "printf hello" },
  idempotency_key: "command",
};
const source = `import { defineConnector } from '@lobu/connector-sdk';
export default defineConnector({key:'device-bridge-fixture',name:'Device bridge fixture',version:'1.0.0',
 authSchema:{methods:[{type:'none'}]},actions:{run:{name:'Run',kind:'write',
 execute:async ctx=>({success:true,output:await ctx.operations.execute(ctx.input)})}}});`;
let code: string;
const job = {
  mode: "action" as const,
  actionKey: "run",
  actionInput: request,
  config: {},
  credentials: null,
  sessionState: null,
  env: {},
};
describe("connector operation host bridge", () => {
  beforeAll(async () => {
    code = (await compileConnectorSource(source)).compiledCode;
  });
  it("passes a durable receipt through the actual isolate without native imports", async () => {
    const receipt = {
      action: "execute" as const,
      status: "pending_approval" as const,
      run_id: 456,
      approval_url: "https://gateway.test/approval",
      message: "Approval needed",
    };
    const hook = vi.fn(async () => receipt);
    expect(
      await new IsolateExecutor().execute(code, job, {
        onOperationExecute: hook,
      })
    ).toMatchObject({ output: receipt });
    expect(hook).toHaveBeenCalledExactlyOnceWith(request);
  });
  it("fails closed when the host did not supply an operation bridge", async () => {
    await expect(new IsolateExecutor().execute(code, job)).rejects.toThrow(
      /operation.*not available/i
    );
  });
  it("rejects routing or authority fields from guest code", async () => {
    const hook = vi.fn();
    await expect(
      new IsolateExecutor().execute(
        code,
        { ...job, actionInput: { ...request, worker_id: "forged" } },
        { onOperationExecute: hook }
      )
    ).rejects.toThrow(/Invalid connector operation/);
    expect(hook).not.toHaveBeenCalled();
  });
});
