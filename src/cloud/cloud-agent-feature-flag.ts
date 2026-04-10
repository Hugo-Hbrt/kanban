// ---------------------------------------------------------------------------
// Cloud Agent Feature Flag + Internal Allowlist — B3
// @phase MVP
// @prd-section 0, 15.9
// ---------------------------------------------------------------------------
//
// Gates cloud-agent task execution behind:
//   1. An environment-level feature flag (KANBAN_CLOUD_AGENT_ENABLED)
//   2. An internal allowlist of user IDs, org IDs, or environment identifiers
//
// PRD: Section 15.9, Section 0 (How to access it)
// ---------------------------------------------------------------------------

/**
 * Feature flag environment variable.
 * Set to "true" or "1" to enable cloud-agent execution.
 */
export const CLOUD_AGENT_FEATURE_FLAG_ENV = "KANBAN_CLOUD_AGENT_ENABLED";

/**
 * Comma-separated allowlist of authorized identifiers.
 * Can contain user IDs, org IDs, or environment tags (e.g. "internal", "dev").
 * When empty/absent, the allowlist check is skipped (flag-only gating).
 */
export const CLOUD_AGENT_ALLOWLIST_ENV = "KANBAN_CLOUD_AGENT_ALLOWLIST";

/** Context for evaluating cloud-agent feature flag + allowlist. */
export interface CloudAgentFeatureFlagContext {
	readonly userId?: string | null | undefined;
	readonly orgId?: string | null | undefined;
	readonly environmentTag?: string | null | undefined;
}

/** Parse a boolean-ish environment variable value. */
export function parseBooleanEnvVar(value: string | undefined | null): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "true" || normalized === "1" || normalized === "yes";
}

/** Parse a comma-separated allowlist string into a normalized set. */
export function parseAllowlist(value: string | undefined | null): ReadonlySet<string> {
	if (!value) return new Set();
	const entries = new Set<string>();
	for (const entry of value.split(",")) {
		const trimmed = entry.trim().toLowerCase();
		if (trimmed.length > 0) entries.add(trimmed);
	}
	return entries;
}

/**
 * Check whether any context identifiers appear in the allowlist.
 * Empty allowlist means flag-only gating — allow all.
 */
export function isContextInAllowlist(allowlist: ReadonlySet<string>, context: CloudAgentFeatureFlagContext): boolean {
	if (allowlist.size === 0) return true;
	const candidates: string[] = [];
	if (context.userId) candidates.push(context.userId.trim().toLowerCase());
	if (context.orgId) candidates.push(context.orgId.trim().toLowerCase());
	if (context.environmentTag) candidates.push(context.environmentTag.trim().toLowerCase());
	return candidates.some((candidate) => allowlist.has(candidate));
}

export interface CloudAgentFeatureFlagResult {
	readonly enabled: boolean;
	readonly flagEnabled: boolean;
	readonly allowlistPassed: boolean;
}

/**
 * Evaluate whether cloud-agent execution is enabled for the given context.
 * Both the feature flag AND the allowlist must pass.
 */
export function evaluateCloudAgentFeatureFlag(
	env: Record<string, string | undefined>,
	context: CloudAgentFeatureFlagContext = {},
): CloudAgentFeatureFlagResult {
	const flagEnabled = parseBooleanEnvVar(env[CLOUD_AGENT_FEATURE_FLAG_ENV]);
	if (!flagEnabled) {
		return { enabled: false, flagEnabled: false, allowlistPassed: false };
	}
	const allowlist = parseAllowlist(env[CLOUD_AGENT_ALLOWLIST_ENV]);
	const allowlistPassed = isContextInAllowlist(allowlist, context);
	return { enabled: flagEnabled && allowlistPassed, flagEnabled, allowlistPassed };
}

/**
 * Convenience: check if cloud-agent execution is enabled using process.env.
 */
export function isCloudAgentEnabled(context: CloudAgentFeatureFlagContext = {}): boolean {
	return evaluateCloudAgentFeatureFlag(process.env, context).enabled;
}
