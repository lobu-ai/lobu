import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureComponent,
  selectedRuntimeComponents,
  type ComponentDescriptor,
} from "../internal/runtime-components.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});
const component: ComponentDescriptor = {
  name: "@lobu/runtime-server",
  version: "20.0.0",
  entries: { server: "dist/server.mjs" },
};
async function fixture() {
  const cacheRoot = await mkdtemp(join(tmpdir(), "lobu-components-"));
  directories.push(cacheRoot);
  let downloads = 0;
  let installs = 0;
  const options = {
    cacheRoot,
    fetchArtifact: async (
      descriptor: ComponentDescriptor,
      directory: string
    ) => {
      downloads++;
      await mkdir(join(directory, "dist"));
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify(descriptor)
      );
      await writeFile(
        join(directory, "dist/server.mjs"),
        "export const version = '20.0.0';"
      );
    },
    installDependencies: async (directory: string) => {
      installs++;
      await mkdir(join(directory, "node_modules"));
    },
  };
  return { options, counts: () => ({ downloads, installs }) };
}

describe("runtime planning", () => {
  test("selects embedded storage and local inference by default", () => {
    expect(selectedRuntimeComponents("server", {})).toEqual([
      "server",
      "postgres",
      "embeddings",
    ]);
  });
  test("external database and remote embeddings skip both native components", () => {
    expect(
      selectedRuntimeComponents("server", {
        DATABASE_URL: " postgres://localhost/test ",
        EMBEDDINGS_SERVICE_URL: "https://embeddings.example.test",
      })
    ).toEqual(["server"]);
  });
  test("OpenAI backend needs the service but not local ONNX", () => {
    expect(
      selectedRuntimeComponents("server", { EMBEDDINGS_BACKEND: "openai" })
    ).toEqual(["server", "postgres"]);
  });
  test("remote device workers never install a database or inference", () => {
    expect(
      selectedRuntimeComponents("device", {
        EMBEDDINGS_SERVICE_URL: "https://embeddings.example.test",
      })
    ).toEqual(["device"]);
  });
  test("connector and one-shot Automation commands need no inference", () => {
    expect(selectedRuntimeComponents("device", {}, false)).toEqual(["device"]);
  });
});

describe("atomic runtime installation", () => {
  test("local dependency links survive moving the completed installation", async () => {
    const { options } = await fixture();
    const directory = await ensureComponent(component, {
      ...options,
      installDependencies: async (temporary) => {
        await options.installDependencies(temporary);
        await symlink(
          join(temporary, "package.json"),
          join(temporary, "node_modules/linked-manifest.json")
        );
      },
    });
    expect(
      JSON.parse(
        await readFile(
          join(directory, "node_modules/linked-manifest.json"),
          "utf8"
        )
      ).name
    ).toBe(component.name);
  });
  test("rejects a corrupted download before unpacking or installing", async () => {
    const { options, counts } = await fixture();
    let requests = 0;
    await expect(
      ensureComponent(component, {
        cacheRoot: options.cacheRoot,
        installDependencies: options.installDependencies,
        fetchImpl: (async () => {
          requests++;
          return requests === 1
            ? Response.json({
                ...component,
                dist: {
                  tarball:
                    "https://registry.npmjs.org/@lobu/runtime-server/-/runtime-server-20.0.0.tgz",
                  integrity: "sha512-incorrect",
                },
              })
            : new Response("corrupted archive");
        }) as typeof fetch,
      })
    ).rejects.toThrow("integrity check failed");
    expect(requests).toBe(2);
    expect(counts().installs).toBe(0);
  });
  test("native verification failure cannot create a complete cache entry", async () => {
    const { options } = await fixture();
    const verified = { ...component, verify: "dist/verify.mjs" };
    await expect(
      ensureComponent(verified, {
        ...options,
        fetchArtifact: async (descriptor, directory) => {
          await options.fetchArtifact(descriptor, directory);
          await writeFile(
            join(directory, "dist/verify.mjs"),
            "process.exit(7);"
          );
        },
      })
    ).rejects.toThrow("Runtime verification failed (7)");
    await expect(
      ensureComponent(verified, { cacheRoot: options.cacheRoot, offline: true })
    ).rejects.toThrow("not cached");
  });
  test("cancellation does not promote an otherwise successful install", async () => {
    const { options } = await fixture();
    const controller = new AbortController();
    await expect(
      ensureComponent(component, {
        ...options,
        signal: controller.signal,
        installDependencies: async (directory) => {
          await options.installDependencies(directory);
          controller.abort(new Error("cancelled"));
        },
      })
    ).rejects.toThrow("cancelled");
    await expect(
      ensureComponent(component, {
        cacheRoot: options.cacheRoot,
        offline: true,
      })
    ).rejects.toThrow("not cached");
  });
  test("concurrent starts install once, then work offline without network", async () => {
    const { options, counts } = await fixture();
    const paths = await Promise.all(
      Array.from({ length: 4 }, () => ensureComponent(component, options))
    );
    expect(new Set(paths).size).toBe(1);
    expect(counts()).toEqual({ downloads: 1, installs: 1 });
    expect(
      await ensureComponent(component, {
        cacheRoot: options.cacheRoot,
        offline: true,
      })
    ).toBe(paths[0]!);
    expect(
      await readFile(join(paths[0]!, "dist/server.mjs"), "utf8")
    ).toContain("20.0.0");
  });
  test("a failed install is never promoted and retry can complete", async () => {
    const { options } = await fixture();
    await expect(
      ensureComponent(component, {
        ...options,
        installDependencies: async () => {
          throw new Error("interrupted");
        },
      })
    ).rejects.toThrow("interrupted");
    await expect(
      ensureComponent(component, {
        cacheRoot: options.cacheRoot,
        offline: true,
      })
    ).rejects.toThrow("not cached");
    await expect(ensureComponent(component, options)).resolves.toContain(
      "20.0.0"
    );
  });
  test("upgrades keep the previous component intact", async () => {
    const { options } = await fixture();
    const previous = await ensureComponent(component, options);
    const next = await ensureComponent(
      { ...component, version: "20.0.1" },
      options
    );
    expect(next).not.toBe(previous);
    expect(
      await ensureComponent(component, {
        cacheRoot: options.cacheRoot,
        offline: true,
      })
    ).toBe(previous);
  });
  test("rejects a mismatched release and missing entry before promotion", async () => {
    const { options } = await fixture();
    await expect(
      ensureComponent(component, {
        ...options,
        fetchArtifact: async (_descriptor, directory) =>
          options.fetchArtifact({ ...component, version: "99.0.0" }, directory),
      })
    ).rejects.toThrow("identity mismatch");
    await expect(
      ensureComponent(
        { ...component, entries: { server: "dist/missing.mjs" } },
        options
      )
    ).rejects.toThrow("missing dist/missing.mjs");
  });
  test("rejects arbitrary package names and path-shaped versions", async () => {
    await expect(
      ensureComponent({ ...component, name: "another-package" })
    ).rejects.toThrow("identity");
    await expect(
      ensureComponent({ ...component, version: "../../data" })
    ).rejects.toThrow("identity");
  });
});
