import { describe, expect, it } from "bun:test";
import { requiredSdkAccess, type MethodAccessMetadata } from "../../../sandbox/method-metadata";
import {
	effectiveSdkRequiredTier,
	resolveSdkAccessGuidance,
	sdkMethodVisible,
} from "../../../sandbox/sdk-method-access";

describe("sdkMethodVisible", () => {
	it("read mode exposes only read-tier methods", () => {
		expect(sdkMethodVisible("read", "read", "read")).toBe(true);
		expect(sdkMethodVisible("write", "admin", "read")).toBe(false);
		expect(sdkMethodVisible("admin", "admin", "read")).toBe(false);
	});

	it("full mode exposes read methods to every caller", () => {
		expect(sdkMethodVisible("read", "read", "full")).toBe(true);
		expect(sdkMethodVisible("read", "write", "full")).toBe(true);
		expect(sdkMethodVisible("read", "admin", "full")).toBe(true);
	});

	it("full mode exposes write methods to write and admin tiers", () => {
		expect(sdkMethodVisible("write", "read", "full")).toBe(false);
		expect(sdkMethodVisible("write", "write", "full")).toBe(true);
		expect(sdkMethodVisible("write", "admin", "full")).toBe(true);
	});

	it("full mode exposes admin methods only to admin tier", () => {
		expect(sdkMethodVisible("admin", "read", "full")).toBe(false);
		expect(sdkMethodVisible("admin", "write", "full")).toBe(false);
		expect(sdkMethodVisible("admin", "admin", "full")).toBe(true);
	});

	it("full mode treats external like write", () => {
		expect(sdkMethodVisible("external", "read", "full")).toBe(false);
		expect(sdkMethodVisible("external", "write", "full")).toBe(true);
		expect(sdkMethodVisible("external", "admin", "full")).toBe(true);
	});
});

describe("SDK access guidance", () => {
	it("advertises account capabilities by scope without assigning a workspace role", () => {
		expect(resolveSdkAccessGuidance({ access: "admin" }, null, ["mcp:admin"], true).available).toBe(true);
		expect(resolveSdkAccessGuidance({ access: "admin" }, null, ["mcp:write"], true).progressivelyAuthorizable).toBe(true);
		expect(resolveSdkAccessGuidance({ access: "admin" }, "member", ["mcp:admin"]).available).toBe(false);
	});
	it("reports each explicit permission tier", () => {
		expect(effectiveSdkRequiredTier({ access: "read" })).toBe("read");
		expect(effectiveSdkRequiredTier({ access: "write" })).toBe("operate");
		expect(effectiveSdkRequiredTier({ access: "external", enforcedTier: "write" })).toBe("operate");
		expect(effectiveSdkRequiredTier({ access: "admin" })).toBe("administer");
		expect(effectiveSdkRequiredTier([{ access: "read" }, { access: "external", enforcedTier: "write" }, { access: "admin" }])).toBe(
			"administer",
		);
	});

	it("reports an external method's enforcedTier, not the write its marker implies", () => {
		// `external` is a side-effect marker, so it mapped to operate for BOTH
		// visibility and reporting. `connections.test` / `feeds.trigger` /
		// `authProfiles.test` are external but admin-ENFORCED, so an mcp:write
		// caller was told "operate (mcp:write)", retried, and hit a hard
		// "requires an MCP session with admin access."
		expect(
			effectiveSdkRequiredTier({ access: "external", enforcedTier: "admin" }),
		).toBe("administer");
		// An external method that really is write-enforced still reports operate.
		expect(
			effectiveSdkRequiredTier({ access: "external", enforcedTier: "write" }),
		).toBe("operate");
		// Incomplete metadata is rejected rather than under-reporting permissions.
		expect(() => effectiveSdkRequiredTier({ access: "external" } as never)).toThrow("no enforced tier");
	});

	it("takes the strictest enforcedTier across a lifecycle", () => {
		// A connector lifecycle bundles reads with feeds.trigger; the aggregate
		// must be the admin the trigger enforces, not the operate its peers imply.
		expect(
			effectiveSdkRequiredTier([
				{ access: "read" },
				{ access: "external", enforcedTier: "admin" },
			]),
		).toBe("administer");
	});

	it("sends an mcp:write caller to the admin path for an admin-enforced external method", () => {
		// The end-to-end symptom: guidance must not say "retry with mcp:write".
		const guidance = resolveSdkAccessGuidance(
			{ access: "external", enforcedTier: "admin" },
			"owner",
			["mcp:read", "mcp:write"],
		);

		expect(guidance.requiredTier).toBe("administer");
		expect(guidance.available).toBe(false);
		expect(guidance.progressivelyAuthorizable).toBe(true);
	});

	it("keeps external methods write-VISIBLE even when admin-enforced", () => {
		// Reporting changed; visibility must not. An owner/admin still needs to
		// see and call the method to trigger the progressive mcp:admin challenge.
		expect(sdkMethodVisible("external", "write", "full")).toBe(true);
	});

	it("marks owner/admin mcp:write callers as progressively authorizable for admin methods", () => {
		const guidance = resolveSdkAccessGuidance({ access: "admin" }, "owner", [
			"mcp:read",
			"mcp:write",
		]);

		expect(guidance.available).toBe(false);
		expect(guidance.progressivelyAuthorizable).toBe(true);
		expect(guidance.requiredTier).toBe("administer");
		expect(guidance.instruction).toMatch(/progressively authorizable|OAuth challenge/i);
		expect(guidance.instruction).toContain("mcp:admin");
	});

	it("tells a regular member to hand administer work to an owner/admin", () => {
		const guidance = resolveSdkAccessGuidance({ access: "admin" }, "member", [
			"mcp:read",
			"mcp:write",
			"mcp:admin",
		]);

		expect(guidance.available).toBe(false);
		expect(guidance.instruction).toMatch(/ask a workspace owner\/admin/i);
		expect(guidance.instruction).toMatch(/cannot elevate/i);
	});

	it("recognizes an owner/admin with mcp:admin as ready to administer", () => {
		const guidance = resolveSdkAccessGuidance({ access: "admin" }, "admin", [
			"mcp:admin",
		]);

		expect(guidance.available).toBe(true);
		expect(guidance.instruction).toBeUndefined();
	});
});

describe("requiredSdkAccess", () => {
	// `MethodAccessMetadata` makes `{ access: "external" }` with no
	// `enforcedTier` unrepresentable, but tsconfig.json excludes
	// `src/**/__tests__/**` from the typecheck program, so the compiler does not
	// police this file. These assert the runtime half: metadata reaching the
	// resolver from an untyped edge (JSON, a cast) fails loudly instead of
	// silently under-reporting the tier a caller needs.
	it("returns the enforced tier for an external method", () => {
		expect(
			requiredSdkAccess({ access: "external", enforcedTier: "admin" }),
		).toBe("admin");
	});

	it("returns the marker itself for a plainly-tiered method", () => {
		expect(requiredSdkAccess({ access: "read" })).toBe("read");
		expect(requiredSdkAccess({ access: "write" })).toBe("write");
		expect(requiredSdkAccess({ access: "admin" })).toBe("admin");
	});

	it("throws rather than under-report when an external method has no tier", () => {
		expect(() =>
			requiredSdkAccess({ access: "external" } as MethodAccessMetadata),
		).toThrow("no enforced tier");
	});
});
