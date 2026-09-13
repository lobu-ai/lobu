import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readRuntimeComponents,
  waitForRuntimeComponents,
} from "../lib/published-runtime-readiness.mjs";

const components = [
  { name: "@example/runtime-one", version: "1.2.3-canary.7" },
  { name: "@example/runtime-two", version: "4.5.6" },
];

function registryProbe(reply: (url: string, call: number) => Response) {
  let time = 0;
  const calls: string[] = [];
  const sleeps: number[] = [];
  return {
    calls,
    sleeps,
    advance: (ms: number) => {
      time += ms;
    },
    options: {
      waitMs: 25,
      pollMs: 10,
      now: () => time,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        time += ms;
      },
      log: () => undefined,
      fetchImpl: async (url: string) => {
        calls.push(url);
        return reply(url, calls.length);
      },
    },
  };
}

function available(component: (typeof components)[number]) {
  return Response.json({
    ...component,
    dist: { tarball: "https://registry.npmjs.org/example/-/example.tgz" },
  });
}

describe("published runtime readiness", () => {
  it("waits for a delayed component without checking already visible components again", async () => {
    const probe = registryProbe((url, call) =>
      url.includes("runtime-two")
        ? available(components[1])
        : call < 3
          ? new Response("not propagated", { status: 404 })
          : available(components[0])
    );
    await waitForRuntimeComponents(components, probe.options);
    expect(probe.sleeps).toEqual([10]);
    expect(probe.calls).toEqual([
      "https://registry.npmjs.org/%40example%2Fruntime-one/1.2.3-canary.7",
      "https://registry.npmjs.org/%40example%2Fruntime-two/4.5.6",
      "https://registry.npmjs.org/%40example%2Fruntime-one/1.2.3-canary.7",
    ]);
  });

  it("shares one deadline across components and caps the final wait", async () => {
    const probe = registryProbe(() => new Response(null, { status: 404 }));
    await expect(
      waitForRuntimeComponents(components, probe.options)
    ).rejects.toThrow("publication wait budget");
    expect(probe.sleeps).toEqual([10, 10, 5]);
    expect(probe.calls).toHaveLength(6);
  });

  it("includes request time in the remaining budget", async () => {
    const probe = registryProbe(() => {
      probe.advance(17);
      return new Response(null, { status: 404 });
    });
    await expect(
      waitForRuntimeComponents([components[0]], probe.options)
    ).rejects.toThrow("publication wait budget");
    expect(probe.sleeps).toEqual([8]);
    expect(probe.calls).toHaveLength(1);
  });

  it("PUBLISH_WAIT=0 checks every descriptor once without sleeping", async () => {
    const probe = registryProbe(() => new Response(null, { status: 404 }));
    await expect(
      waitForRuntimeComponents(components, { ...probe.options, waitMs: 0 })
    ).rejects.toThrow("publication wait budget");
    expect(probe.calls).toHaveLength(2);
    expect(probe.sleeps).toEqual([]);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`does not retry HTTP ${status}`, async () => {
      const probe = registryProbe(() => new Response(null, { status }));
      await expect(
        waitForRuntimeComponents([components[0]], probe.options)
      ).rejects.toThrow(`HTTP ${status}`);
      expect(probe.calls).toHaveLength(1);
      expect(probe.sleeps).toEqual([]);
    });
  }

  it("does not retry network failures", async () => {
    const probe = registryProbe(() => {
      throw new Error("connection reset");
    });
    await expect(
      waitForRuntimeComponents(components, probe.options)
    ).rejects.toThrow("connection reset");
    expect(probe.sleeps).toEqual([]);
  });

  for (const body of [
    "not JSON",
    JSON.stringify({ ...components[0], version: "9.9.9" }),
    JSON.stringify({ ...components[0], name: "@example/different" }),
    JSON.stringify(components[0]),
  ]) {
    it("rejects corrupt or mismatched registry metadata without retrying", async () => {
      const probe = registryProbe(() => new Response(body));
      await expect(
        waitForRuntimeComponents([components[0]], probe.options)
      ).rejects.toThrow();
      expect(probe.calls).toHaveLength(1);
      expect(probe.sleeps).toEqual([]);
    });
  }

  it("reads exact names and versions from installed descriptors, while allowing older CLIs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runtime-readiness-"));
    const manifest = join(directory, "runtime-components.json");
    try {
      expect(await readRuntimeComponents(manifest)).toEqual([]);
      await writeFile(manifest, JSON.stringify({ arbitrary: components[1] }));
      expect(await readRuntimeComponents(manifest)).toEqual([components[1]]);
      for (const invalid of [
        "null",
        "[]",
        "{}",
        "not JSON",
        JSON.stringify({
          server: { name: "@example/runtime", version: "latest" },
        }),
      ]) {
        await writeFile(manifest, invalid);
        await expect(readRuntimeComponents(manifest)).rejects.toThrow();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("gates component commands and retains the remaining CLI publication budget", async () => {
    const smoke = await Bun.file(
      new URL("../published-artifact-smoke.sh", import.meta.url)
    ).text();
    expect(
      smoke.indexOf("scripts/lib/published-runtime-readiness.mjs")
    ).toBeLessThan(smoke.indexOf('"$LOBU_BIN" connector runtime-self-check'));
    expect(smoke).toContain('"$((PUBLISH_WAIT - waited))" "$PUBLISH_POLL"');
    expect(smoke).toContain(
      '"$INSTALL_DIR/node_modules/@lobu/cli/dist/runtime-components.json"'
    );
  });

  it("uses decimal seconds for validated wait settings, including leading zeros", async () => {
    const smoke = await Bun.file(
      new URL("../published-artifact-smoke.sh", import.meta.url)
    ).text();
    const configurationStart = smoke.indexOf(
      'PUBLISH_WAIT="${PUBLISH_WAIT:-600}"'
    );
    const configurationEnd = smoke.indexOf("MOCK_REPLY=", configurationStart);
    expect(configurationStart).toBeGreaterThanOrEqual(0);
    expect(configurationEnd).toBeGreaterThan(configurationStart);
    const configuration = smoke.slice(configurationStart, configurationEnd);
    for (const [input, seconds] of [
      ["08", 8],
      ["0010", 10],
      ["0008", 8],
      ["0", 0],
      ["000", 0],
      ["600", 600],
    ] as const) {
      const result = spawnSync(
        "bash",
        [
          "-euc",
          `${configuration}\nprintf '%s:%s\\n' "$((PUBLISH_WAIT - 0))" "$PUBLISH_POLL"`,
        ],
        { encoding: "utf8", env: { ...process.env, PUBLISH_WAIT: input } }
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`${seconds}:10`);
    }
  });

  it("runs a pinned Bun consumer as nonroot in addition to all four Node environments", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(
        new URL(
          "../../.github/workflows/published-artifact-smoke.yml",
          import.meta.url
        )
      ).text()
    ) as any;
    const cells = workflow.jobs.smoke.strategy.matrix.include;
    expect(cells.filter((cell: any) => !cell.bun)).toHaveLength(4);
    expect(cells.find((cell: any) => cell.bun === "1.4.0")).toMatchObject({
      as_root: false,
      image: "node:22-bookworm-slim",
    });
    const steps = workflow.jobs.smoke.steps;
    expect(
      steps.find((step: any) => step.uses === "oven-sh/setup-bun@v2")?.with[
        "bun-version"
      ]
    ).toBe("${{ matrix.bun }}");
    expect(steps.map((step: any) => step.run ?? "").join("\n")).toContain(
      "/usr/local/bin/bun"
    );
  });
});
