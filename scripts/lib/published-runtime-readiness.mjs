import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;

export async function readRuntimeComponents(manifestPath) {
  let text;
  try {
    text = await readFile(manifestPath, "utf8");
  } catch (error) {
    // Older published CLIs install their runtime as ordinary dependencies.
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const manifest = JSON.parse(text);
  if (!manifest || Array.isArray(manifest) || typeof manifest !== "object") {
    throw new Error("Invalid installed CLI runtime component manifest");
  }
  const components = Object.values(manifest);
  if (
    components.length === 0 ||
    components.some(
      (component) =>
        !component ||
        typeof component.name !== "string" ||
        !packageName.test(component.name) ||
        typeof component.version !== "string" ||
        !exactVersion.test(component.version)
    )
  ) {
    throw new Error(
      "Runtime components must declare package names and exact versions"
    );
  }
  return components.map(({ name, version }) => ({ name, version }));
}

export async function waitForRuntimeComponents(
  components,
  {
    waitMs,
    pollMs,
    fetchImpl = fetch,
    now = () => performance.now(),
    sleep = delay,
    log = console.log,
  }
) {
  if (
    !Number.isFinite(waitMs) ||
    waitMs < 0 ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0
  ) {
    throw new Error("Invalid runtime publication wait budget or poll interval");
  }
  const deadline = now() + waitMs;
  let pending = components;
  while (pending.length > 0) {
    const missing = await Promise.all(
      pending.map(async (component) => {
        const { name, version } = component;
        const label = `${name}@${version}`;
        // PUBLISH_WAIT=0 still performs one bounded request per component.
        const timeout =
          waitMs === 0
            ? 30_000
            : Math.max(1, Math.min(30_000, deadline - now()));
        const response = await fetchImpl(
          `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
          { signal: AbortSignal.timeout(Math.ceil(timeout)) }
        );
        if (response.status === 404) {
          await response.body?.cancel();
          return component;
        }
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(
            `Runtime metadata ${label} returned HTTP ${response.status}; not waiting for propagation`
          );
        }
        const metadata = await response.json();
        if (
          metadata?.name !== name ||
          metadata.version !== version ||
          typeof metadata.dist?.tarball !== "string" ||
          !metadata.dist.tarball.startsWith("https://")
        ) {
          throw new Error(
            `Invalid registry metadata for ${label}; not waiting for propagation`
          );
        }
        return null;
      })
    );
    pending = missing.filter(Boolean);
    if (pending.length === 0) return;
    const unavailable = pending
      .map(({ name, version }) => `${name}@${version}`)
      .join(", ");
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new Error(
        `Runtime versions still unavailable after the publication wait budget: ${unavailable}`
      );
    }
    log(`Waiting for runtime registry propagation: ${unavailable}`);
    await sleep(Math.min(pollMs, remaining));
    if (now() >= deadline) {
      throw new Error(
        `Runtime versions still unavailable after the publication wait budget: ${unavailable}`
      );
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const [manifestPath, waitSeconds, pollSeconds] = process.argv.slice(2);
    const components = await readRuntimeComponents(manifestPath);
    await waitForRuntimeComponents(components, {
      waitMs: Number(waitSeconds) * 1000,
      pollMs: Number(pollSeconds) * 1000,
    });
    console.log(
      `Runtime registry metadata ready (${components.length} components)`
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
