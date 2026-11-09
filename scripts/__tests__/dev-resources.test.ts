import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  buildConcurrency,
  memoryLimit,
  nodeOptionsForMemory,
} from "../lib/dev-resources.mjs";

const GIB = 1024 ** 3;

describe("container resource budgets", () => {
  test("terminates at a namespace-relative cgroup root", () => {
    const moduleUrl = new URL("../lib/dev-resources.mjs", import.meta.url).href;
    // A child-process timeout makes the pre-fix synchronous loop fail rather
    // than hanging the test runner itself.
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `
      import { memoryLimit } from ${JSON.stringify(moduleUrl)};
      const files = {
        "/proc/self/cgroup": "0::/",
        "/sys/fs/cgroup/memory.max": "2147483648"
      };
      const read = path => {
        if (!(path in files)) throw new Error("ENOENT");
        return files[path];
      };
      console.log(memoryLimit(read, 8 * 1024 ** 3));
    `,
      ],
      { encoding: "utf8", timeout: 2_000 }
    );
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(String(2 * GIB));
  });

  test("finds the parent limit when init.scope is unlimited", () => {
    const files: Record<string, string> = {
      "/proc/self/cgroup": "0::/init.scope\n",
      "/sys/fs/cgroup/init.scope/memory.max": "max",
      "/sys/fs/cgroup/init.scope/memory.high": "max",
      "/sys/fs/cgroup/memory.max": String(2 * GIB),
    };
    const read = (path: string) => {
      if (!(path in files)) throw new Error("ENOENT");
      return files[path];
    };
    expect(memoryLimit(read, 756 * GIB)).toBe(2 * GIB);
    files["/sys/fs/cgroup/init.scope/memory.high"] = String(GIB);
    expect(memoryLimit(read, 756 * GIB)).toBe(GIB);
  });

  test("leaves hosts without cgroups alone", () => {
    expect(
      memoryLimit(() => {
        throw new Error("ENOENT");
      })
    ).toBeUndefined();
    expect(nodeOptionsForMemory("--enable-source-maps", null)).toBe(
      "--enable-source-maps"
    );
    expect(buildConcurrency(null)).toBe(Infinity);
  });

  test("caps an inherited oversized heap and preserves unrelated flags", () => {
    expect(
      nodeOptionsForMemory(
        "--enable-source-maps --max_old_space_size=8192",
        2 * GIB
      )
    ).toBe("--enable-source-maps --max-old-space-size=819");
    expect(
      nodeOptionsForMemory("--max-old-space-size 512 --trace-warnings", 2 * GIB)
    ).toBe("--trace-warnings --max-old-space-size=512");
    expect(buildConcurrency(2 * GIB)).toBe(1);
    expect(buildConcurrency(4 * GIB)).toBe(2);
  });

  test("caps V8's automatic heap selection when the inherited value is zero", () => {
    expect(nodeOptionsForMemory("--max-old-space-size=0", 2 * GIB)).toBe(
      "--max-old-space-size=819"
    );
  });
});
