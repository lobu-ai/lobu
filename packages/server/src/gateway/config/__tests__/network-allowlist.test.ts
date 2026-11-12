import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadAllowedDomains } from "../network-allowlist.js";

const WAD_PRESERVE = process.env.WORKER_ALLOWED_DOMAINS;

beforeEach(() => {
  delete process.env.WORKER_ALLOWED_DOMAINS;
});

afterEach(() => {
  if (WAD_PRESERVE === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
  else process.env.WORKER_ALLOWED_DOMAINS = WAD_PRESERVE;
});

describe("loadAllowedDomains", () => {
  test("unset → complete isolation", () => {
    expect(loadAllowedDomains()).toEqual([]);
  });

  test("allowlist → only the listed domains", () => {
    process.env.WORKER_ALLOWED_DOMAINS = "github.com, api.example.com";
    const allowed = loadAllowedDomains();
    expect(allowed).toContain("github.com");
    expect(allowed).toContain("api.example.com");
    expect(allowed).toHaveLength(2);
  });

  test("unrestricted (*) mode is left untouched", () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    expect(loadAllowedDomains()).toEqual(["*"]);
  });
});
