// ---------------------------------------------------------------------------
// Cloud Auth Provider — KB-AUTH-1
// ---------------------------------------------------------------------------
//
// Retrieves the existing Cline-authenticated credential for outbound
// cloud-platform and core-platform API calls.
//
// Key design decision: Kanban reuses the Cline API key that the extension
// already provides at launch. There is no separate cloud-platform API key.
// The Cline API key is forwarded as a Bearer token to cloud-platform and
// core-platform, which validate it against the same identity provider.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Provides authentication headers for outbound cloud-platform and
 * core-platform API calls.
 *
 * Implementations retrieve the credential from the Kanban runtime context
 * (environment variable or injected Cline launch config). The credential
 * is the user's Cline API key — no separate cloud-platform key is needed.
 */
export interface CloudAuthProvider {
	getAuthHeaders(): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Environment-based Implementation
// ---------------------------------------------------------------------------

/**
 * Resolves the Cline API key from environment variables.
 *
 * Lookup order:
 *   1. Constructor-injected `apiKey` (highest priority — from Cline launch config)
 *   2. `KANBAN_CLOUD_PLATFORM_API_KEY` (legacy env var — removed in KB-AUTH-4)
 *   3. `KANBAN_GOVERNANCE_AUTH_TOKEN` (governance-specific fallback)
 *
 * The resolved key is sent as `Authorization: Bearer <key>` on every
 * outbound call to cloud-platform and core-platform.
 */
export class EnvironmentCloudAuthProvider implements CloudAuthProvider {
	private readonly apiKey: string;

	constructor(opts: {
		apiKey?: string;
		env?: Record<string, string | undefined>;
	} = {}) {
		const env = opts.env ?? process.env;
		this.apiKey =
			opts.apiKey ??
			env.KANBAN_CLOUD_PLATFORM_API_KEY ??
			env.KANBAN_GOVERNANCE_AUTH_TOKEN ??
			"";
	}

	async getAuthHeaders(): Promise<Record<string, string>> {
		if (!this.apiKey) {
			return {};
		}
		return {
			Authorization: `Bearer ${this.apiKey}`,
		};
	}
}

// ---------------------------------------------------------------------------
// Static (testing) Implementation
// ---------------------------------------------------------------------------

/**
 * Auth provider with a fixed token. Useful for tests and local development.
 */
export class StaticCloudAuthProvider implements CloudAuthProvider {
	constructor(private readonly token: string) {}

	async getAuthHeaders(): Promise<Record<string, string>> {
		if (!this.token) return {};
		return { Authorization: `Bearer ${this.token}` };
	}
}
