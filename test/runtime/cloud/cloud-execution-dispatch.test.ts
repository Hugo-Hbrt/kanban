import { describe, expect, it } from "vitest";

import { CLOUD_AGENT_ALLOWLIST_ENV, CLOUD_AGENT_FEATURE_FLAG_ENV } from "../../../src/cloud/cloud-agent-feature-flag";
import { resolveExecutionDispatch } from "../../../src/cloud/cloud-execution-dispatch";

function makeEnv(flagValue?: string, allowlistValue?: string): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	if (flagValue !== undefined) env[CLOUD_AGENT_FEATURE_FLAG_ENV] = flagValue;
	if (allowlistValue !== undefined) env[CLOUD_AGENT_ALLOWLIST_ENV] = allowlistValue;
	return env;
}

describe("resolveExecutionDispatch", () => {
	// -----------------------------------------------------------------
	// local_agent — always routes locally regardless of flag
	// -----------------------------------------------------------------

	describe("local_agent mode", () => {
		it("routes to local when executionMode is local_agent", () => {
			const result = resolveExecutionDispatch("local_agent", makeEnv("true"));
			expect(result.path).toBe("local");
			expect(result.requestedMode).toBe("local_agent");
		});

		it("routes to local when executionMode is undefined", () => {
			const result = resolveExecutionDispatch(undefined, makeEnv("true"));
			expect(result.path).toBe("local");
			expect(result.requestedMode).toBe("local_agent");
		});

		it("routes to local when executionMode is null", () => {
			const result = resolveExecutionDispatch(null, makeEnv("true"));
			expect(result.path).toBe("local");
			expect(result.requestedMode).toBe("local_agent");
		});

		it("routes to local even when flag is off", () => {
			const result = resolveExecutionDispatch("local_agent", makeEnv("false"));
			expect(result.path).toBe("local");
		});
	});

	// -----------------------------------------------------------------
	// cloud_agent — requires feature flag + allowlist
	// -----------------------------------------------------------------

	describe("cloud_agent mode with flag enabled", () => {
		it("routes to cloud when flag is on and no allowlist", () => {
			const result = resolveExecutionDispatch("cloud_agent", makeEnv("true"));
			expect(result.path).toBe("cloud");
			expect(result.requestedMode).toBe("cloud_agent");
			expect(result.cloudAgentEnabled).toBe(true);
		});

		it("routes to cloud when flag is on and context is in allowlist", () => {
			const result = resolveExecutionDispatch("cloud_agent", makeEnv("true", "user-1"), { userId: "user-1" });
			expect(result.path).toBe("cloud");
			expect(result.cloudAgentEnabled).toBe(true);
		});
	});

	describe("cloud_agent mode with flag disabled", () => {
		it("falls back to local when flag is off", () => {
			const result = resolveExecutionDispatch("cloud_agent", makeEnv("false"));
			expect(result.path).toBe("local");
			expect(result.requestedMode).toBe("cloud_agent");
			expect(result.cloudAgentEnabled).toBe(false);
			expect(result.reason).toContain("not enabled");
		});

		it("falls back to local when flag is not set", () => {
			const result = resolveExecutionDispatch("cloud_agent", {});
			expect(result.path).toBe("local");
			expect(result.cloudAgentEnabled).toBe(false);
		});
	});

	describe("cloud_agent mode with allowlist rejection", () => {
		it("falls back to local when context is not in allowlist", () => {
			const result = resolveExecutionDispatch("cloud_agent", makeEnv("true", "user-1"), { userId: "user-99" });
			expect(result.path).toBe("local");
			expect(result.cloudAgentEnabled).toBe(false);
			expect(result.reason).toContain("allowlist");
		});

		it("falls back to local when context is empty and allowlist is non-empty", () => {
			const result = resolveExecutionDispatch("cloud_agent", makeEnv("true", "user-1"), {});
			expect(result.path).toBe("local");
			expect(result.cloudAgentEnabled).toBe(false);
		});
	});

	// -----------------------------------------------------------------
	// Local-agent regression: local always works regardless of flag
	// -----------------------------------------------------------------

	describe("local-agent regression safety", () => {
		it("local_agent always routes locally with flag on", () => {
			const result = resolveExecutionDispatch("local_agent", makeEnv("true"));
			expect(result.path).toBe("local");
		});

		it("local_agent always routes locally with flag off", () => {
			const result = resolveExecutionDispatch("local_agent", makeEnv("false"));
			expect(result.path).toBe("local");
		});

		it("undefined mode always routes locally with flag on", () => {
			const result = resolveExecutionDispatch(undefined, makeEnv("true"));
			expect(result.path).toBe("local");
		});

		it("undefined mode always routes locally with flag off", () => {
			const result = resolveExecutionDispatch(undefined, makeEnv("false"));
			expect(result.path).toBe("local");
		});
	});
});
