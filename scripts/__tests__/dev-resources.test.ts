import { describe, expect, test } from "bun:test";
import {
  buildConcurrency,
  memoryLimit,
  nodeOptionsForMemory,
} from "../lib/dev-resources.mjs";

const GIB = 1024 ** 3;

describe("container resource budgets", () => {
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
