import { describe, expect, it, spyOn } from "bun:test";
import { initTracing, shutdownTracing, SpanStatusCode } from "@lobu/core";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { executeTool, isSoftErrorResult, type AuthContext } from "../../tools/execute";
import { getTool } from "../../tools/registry";
import { ToolUserError } from "../../utils/errors";

const baseAuth: AuthContext = {
  organizationId: "org_tool_validation_test",
  tokenOrganizationId: "org_tool_validation_test",
  userId: "user_test",
  memberRole: "owner",
  agentId: null,
  requestedAgentId: null,
  isAuthenticated: true,
  clientId: "test_client",
  scopes: ["mcp:read", "mcp:write", "mcp:admin"],
  tokenType: "oauth",
  requestUrl: "http://localhost:8787/api/test/query_sdk",
  baseUrl: "http://localhost:8787",
  scopedToOrg: false,
  allowCrossOrg: true,
};

describe("executeTool input-schema validation", () => {
  it("query_sdk with missing 'script' returns a ToolUserError naming the field", async () => {
    let caught: unknown;
    try {
      await executeTool("query_sdk", {}, {} as never, baseAuth);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    const err = caught as ToolUserError;
    expect(err.httpStatus).toBe(400);
    expect(err.message).toMatch(/script/);
    // Don't assert exact wording — only that the field name is in it.
  });

  it("query_sdk with { code: ... } (LLM typo) still reports 'script' missing", async () => {
    let caught: unknown;
    try {
      await executeTool(
        "query_sdk",
        { code: "export default async () => ({ ok: true });" },
        {} as never,
        baseAuth,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).message).toMatch(/script/);
  });

  it("run_sdk with missing 'script' returns a ToolUserError naming the field", async () => {
    let caught: unknown;
    try {
      await executeTool("run_sdk", { dry_run: true }, {} as never, baseAuth);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ToolUserError);
    expect((caught as ToolUserError).httpStatus).toBe(400);
    expect((caught as ToolUserError).message).toMatch(/script/);
  });

  it("query_sdk with valid args passes validation (failure beyond the boundary is fine)", async () => {
    // A valid call passes the boundary validator. The handler may still fail
    // downstream (no real DB in this unit test), but the failure must NOT be
    // a ToolUserError from `validateToolArgs`. That's the contract we care
    // about: schema-valid input is forwarded to the handler unchanged.
    let caught: unknown;
    try {
      await executeTool(
        "query_sdk",
        { script: "export default async () => 1" },
        {} as never,
        baseAuth,
      );
    } catch (err) {
      caught = err;
    }
    if (caught instanceof ToolUserError) {
      expect(caught.message).not.toMatch(/Invalid arguments/);
    }
  });
});

describe("executeTool error spans", () => {
  it.each([
    [{ error: "synthetic failure", error_code: "INTERNAL" }, "system"],
    [{ error: "synthetic failure", code: "INTERNAL" }, "system"],
    [{ error: "synthetic failure", error_code: "UPSTREAM_5XX" }, "dependency"],
    [{ error: "synthetic failure", error_code: "VALIDATION" }, "user"],
    [{ error: "synthetic failure", error_code: "UNKNOWN_FAILURE" }, "system"],
    [{ error: "synthetic failure" }, "user"],
  ])("preserves structured error classification for %j", async (result, kind) => {
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({
      serviceName: "tool-result-span-test",
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const tool = getTool("query_sql");
    if (!tool) throw new Error("query_sql is not registered");
    const handler = spyOn(tool, "handler").mockResolvedValue(result);
    try {
      expect(await executeTool("query_sql", { sql: "SELECT 1" }, {} as never, baseAuth)).toEqual(result);
      const [span] = exporter.getFinishedSpans().filter((s) => s.name === "tool query_sql");
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes["error.kind"]).toBe(kind);
      expect(span?.attributes["error.code"]).toBe("code" in result ? result.code : "error_code" in result ? result.error_code : undefined);
    } finally {
      handler.mockRestore();
      await shutdownTracing();
    }
  });

  it("records a rejected call as one grouped user error per defect", async () => {
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({
      serviceName: "tool-span-test",
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    try {
      for (const args of [{}, { code: "export default async () => 1" }]) {
        await executeTool("query_sdk", args, {} as never, baseAuth).catch(
          () => undefined,
        );
      }
      const spans = exporter
        .getFinishedSpans()
        .filter((span) => span.name === "tool query_sdk");
      expect(spans).toHaveLength(2);
      for (const span of spans) {
        expect(span.status.code).toBe(SpanStatusCode.ERROR);
        expect(span.attributes).toMatchObject({
          "exception.type": "ToolUserError",
          "error.kind": "user",
        });
      }
      expect(spans[0].attributes["error.fingerprint"]).toBe(
        spans[1].attributes["error.fingerprint"],
      );
      expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
        "export default",
      );
    } finally {
      await shutdownTracing();
    }
  });

  it("groups a failed call's log line with its span, not as one generic issue", async () => {
    const exporter = new InMemorySpanExporter();
    const lines: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    await shutdownTracing();
    initTracing({
      serviceName: "tool-span-test",
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    process.stdout.write = ((chunk: string | Uint8Array) => {
      lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
    // Inject a server-side failure past validation; logging and tracing stay real.
    const tool = getTool("query_sdk");
    if (!tool) throw new Error("query_sdk is not registered");
    const handler = spyOn(tool, "handler").mockImplementation(() => {
      throw new Error("database unavailable");
    });
    try {
      await executeTool(
        "query_sdk",
        { script: "export default async () => 1" },
        {} as never,
        baseAuth,
      ).catch(() => undefined);
    } finally {
      process.stdout.write = originalWrite;
      handler.mockRestore();
    }
    // Read before shutdown, which clears the in-memory exporter.
    const [span] = exporter
      .getFinishedSpans()
      .filter((s) => s.name === "tool query_sdk");
    await shutdownTracing();
    const failure = lines
      .flatMap((line) => line.split("\n"))
      .filter((line) => line.includes("Tool call failed"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(failure).toHaveLength(1);
    expect(failure[0]).toMatchObject({
      error_fingerprint: span?.attributes["error.fingerprint"],
      error_type: span?.attributes["exception.type"],
      error_kind: span?.attributes["error.kind"],
    });
    expect(failure[0]).not.toHaveProperty("error_message");
  });
});


describe("SDK script failure telemetry", () => {
  it.each([
    ["query_sdk", "VALIDATION", "user", "ScriptError"],
    ["run_sdk", "PERMISSION", "user", "ScriptError"],
    ["query_sdk", "UPSTREAM_TIMEOUT", "dependency", "ClientSdkActionError"],
    ["run_sdk", "INTERNAL", "system", "RuntimeUnavailable"],
    ["run_sdk", "INTERNAL", "user", "OutOfMemory"],
  ])("records %s %s without turning its report into a tool error", async (toolName, code, kind, name) => {
    const exporter = new InMemorySpanExporter();
    await shutdownTracing();
    initTracing({ serviceName: "sdk-script-span-test", spanProcessors: [new SimpleSpanProcessor(exporter)] });
    const tool = getTool(toolName);
    if (!tool) throw new Error(`${toolName} is not registered`);
    const report = { success: false, error: { name, message: "Synthetic script failure", code, retryable: false } };
    const handler = spyOn(tool, "handler").mockResolvedValue(report);
    try {
      const result = await executeTool(toolName, { script: "export default async () => 1" }, {} as never, baseAuth);
      expect(result).toEqual(report);
      expect(isSoftErrorResult(result)).toBe(false);
      const [span] = exporter.getFinishedSpans().filter((entry) => entry.name === `tool ${toolName}`);
      expect(span?.status.code).toBe(SpanStatusCode.ERROR);
      expect(span?.attributes).toMatchObject({ "exception.type": name, "error.code": code, "error.kind": kind });
    } finally {
      handler.mockRestore();
      await shutdownTracing();
    }
  });
});
