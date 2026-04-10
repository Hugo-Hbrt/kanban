import { describe, expect, it } from "vitest";

import {
	CLOUD_AGENT_ALLOWLIST_ENV,
	CLOUD_AGENT_FEATURE_FLAG_ENV,
	evaluateCloudAgentFeatureFlag,
	isContextInAllowlist,
	parseAllowlist,
	parseBooleanEnvVar,
} from "../../../src/cloud/cloud-agent-feature-flag";

// ---------------------------------------------------------------------------
// parseBooleanEnvVar
// ---------------------------------------------------------------------------

describe("parseBooleanEnvVar", () => {
	it.each([
		["true", true],
		["TRUE", true],
		["True", true],
		["1", true],
		["yes", true],
		["YES", true],
		["  true  ", true],
		["false", false],
		["0", false],
		["no", false],
		["", false],
		["random", false],
	])("parses %j as %s", (input, expected) => {
		expect(parseBooleanEnvVar(input)).toBe(expected);
	});

	it("returns false for undefined", () => {
		expect(parseBooleanEnvVar(undefined)).toBe(false);
	});

	it("returns false for null", () => {
		expect(parseBooleanEnvVar(null)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// parseAllowlist
// ---------------------------------------------------------------------------

describe("parseAllowlist", () => {
	it("returns empty set for undefined", () => {
		expect(parseAllowlist(undefined).size).toBe(0);
	});

	it("returns empty set for null", () => {
		expect(parseAllowlist(null).size).toBe(0);
	});

	it("returns empty set for empty string", () => {
		expect(parseAllowlist("").size).toBe(0);
	});

	it("parses comma-separated values", () => {
		const result = parseAllowlist("user-1,org-abc,internal");
		expect(result.size).toBe(3);
		expect(result.has("user-1")).toBe(true);
		expect(result.has("org-abc")).toBe(true);
		expect(result.has("internal")).toBe(true);
	});

	it("trims whitespace and lowercases entries", () => {
		const result = parseAllowlist("  User-1 , ORG-ABC , Internal  ");
		expect(result.has("user-1")).toBe(true);
		expect(result.has("org-abc")).toBe(true);
		expect(result.has("internal")).toBe(true);
	});

	it("skips empty entries from trailing commas", () => {
		const result = parseAllowlist("user-1,,org-abc,");
		expect(result.size).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// isContextInAllowlist
// ---------------------------------------------------------------------------

describe("isContextInAllowlist", () => {
	it("returns true when allowlist is empty (flag-only gating)", () => {
		expect(isContextInAllowlist(new Set(), { userId: "user-1" })).toBe(true);
	});

	it("returns true when userId is in allowlist", () => {
		const allowlist = new Set(["user-1", "user-2"]);
		expect(isContextInAllowlist(allowlist, { userId: "user-1" })).toBe(true);
	});

	it("returns true when orgId is in allowlist", () => {
		const allowlist = new Set(["org-cline"]);
		expect(isContextInAllowlist(allowlist, { orgId: "org-cline" })).toBe(true);
	});

	it("returns true when environmentTag is in allowlist", () => {
		const allowlist = new Set(["internal"]);
		expect(isContextInAllowlist(allowlist, { environmentTag: "internal" })).toBe(true);
	});

	it("returns false when no context matches allowlist", () => {
		const allowlist = new Set(["user-1"]);
		expect(isContextInAllowlist(allowlist, { userId: "user-99" })).toBe(false);
	});

	it("returns false when context is empty and allowlist is non-empty", () => {
		const allowlist = new Set(["user-1"]);
		expect(isContextInAllowlist(allowlist, {})).toBe(false);
	});

	it("is case-insensitive", () => {
		const allowlist = new Set(["user-1"]);
		expect(isContextInAllowlist(allowlist, { userId: "USER-1" })).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// evaluateCloudAgentFeatureFlag
// ---------------------------------------------------------------------------

describe("evaluateCloudAgentFeatureFlag", () => {
	function makeEnv(flagValue?: string, allowlistValue?: string): Record<string, string | undefined> {
		const env: Record<string, string | undefined> = {};
		if (flagValue !== undefined) env[CLOUD_AGENT_FEATURE_FLAG_ENV] = flagValue;
		if (allowlistValue !== undefined) env[CLOUD_AGENT_ALLOWLIST_ENV] = allowlistValue;
		return env;
	}

	it("returns disabled when feature flag is not set", () => {
		const result = evaluateCloudAgentFeatureFlag({});
		expect(result.enabled).toBe(false);
		expect(result.flagEnabled).toBe(false);
		expect(result.allowlistPassed).toBe(false);
	});

	it("returns disabled when feature flag is false", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("false"));
		expect(result.enabled).toBe(false);
		expect(result.flagEnabled).toBe(false);
	});

	it("returns enabled when flag is true and no allowlist is set", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true"));
		expect(result.enabled).toBe(true);
		expect(result.flagEnabled).toBe(true);
		expect(result.allowlistPassed).toBe(true);
	});

	it("returns enabled when flag is true and context is in allowlist", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "user-1,org-cline"), { userId: "user-1" });
		expect(result.enabled).toBe(true);
		expect(result.flagEnabled).toBe(true);
		expect(result.allowlistPassed).toBe(true);
	});

	it("returns disabled when flag is true but context is NOT in allowlist", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "user-1,org-cline"), { userId: "user-99" });
		expect(result.enabled).toBe(false);
		expect(result.flagEnabled).toBe(true);
		expect(result.allowlistPassed).toBe(false);
	});

	it("returns disabled when flag is true, allowlist set, but no context provided", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "user-1"), {});
		expect(result.enabled).toBe(false);
		expect(result.flagEnabled).toBe(true);
		expect(result.allowlistPassed).toBe(false);
	});

	it("accepts '1' as a truthy flag value", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("1"));
		expect(result.enabled).toBe(true);
	});

	it("allowlist matching is case-insensitive", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "INTERNAL"), { environmentTag: "internal" });
		expect(result.enabled).toBe(true);
	});

	it("matches on orgId when userId does not match", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "org-cline"), {
			userId: "user-99",
			orgId: "org-cline",
		});
		expect(result.enabled).toBe(true);
	});

	it("matches on environmentTag when userId and orgId do not match", () => {
		const result = evaluateCloudAgentFeatureFlag(makeEnv("true", "dev"), {
			userId: "user-99",
			orgId: "org-other",
			environmentTag: "dev",
		});
		expect(result.enabled).toBe(true);
	});
});
