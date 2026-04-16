// ---------------------------------------------------------------------------
// Cloud Capabilities Client
// ---------------------------------------------------------------------------
//
// Thin HTTP client for GET /api/v2/cloud-platform/capabilities on core-api.
// Used to discover whether the authenticated Kanban user is permitted to use
// cloud-agent execution, so the UI can hide or disable the cloud-agent toggle
// for non-eligible users.
//
// Authoritative enforcement happens server-side in core-api (403 on
// POST /executions); this client only enables UI gating. If this request
// fails, the caller should assume "not allowed" — failing closed is the
// right default when we can't reach the policy decision point.
// ---------------------------------------------------------------------------

import type { CloudAuthProvider } from "./cloud-auth-provider";

export interface CloudAgentCapability {
	readonly cloudAgentAllowed: boolean;
	readonly reason: string;
}

export interface CloudCapabilitiesClient {
	getCloudAgentCapability(signal?: AbortSignal): Promise<CloudAgentCapability>;
}

export interface CloudCapabilitiesHttpClientConfig {
	readonly baseUrl: string;
	readonly authProvider: CloudAuthProvider;
	readonly fetch?: typeof globalThis.fetch;
	readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class CloudCapabilitiesHttpClient implements CloudCapabilitiesClient {
	private readonly baseUrl: string;
	private readonly authProvider: CloudAuthProvider;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly timeoutMs: number;

	constructor(config: CloudCapabilitiesHttpClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authProvider = config.authProvider;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	}

	async getCloudAgentCapability(signal?: AbortSignal): Promise<CloudAgentCapability> {
		const authHeaders = await this.authProvider.getAuthHeaders();
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });

		let response: Response;
		try {
			response = await this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/capabilities`, {
				method: "GET",
				headers: {
					...authHeaders,
					"X-Service-Name": "kanban",
				},
				signal: controller.signal,
			});
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}

		if (!response.ok) {
			throw new Error(`capabilities request failed: HTTP ${response.status}`);
		}

		const body = (await response.json()) as unknown;
		return parseCapabilitiesResponse(body);
	}
}

// Tolerant of both raw { cloudAgentAllowed, reason } and core-api's standard
// envelope { data: {...}, success, error } — core-api always wraps, but keeping
// the client lenient protects against future contract drift.
export function parseCapabilitiesResponse(body: unknown): CloudAgentCapability {
	if (body === null || typeof body !== "object") {
		throw new Error("capabilities response: expected object");
	}

	const maybeEnvelope = body as { data?: unknown; success?: unknown; error?: unknown };
	if ("success" in maybeEnvelope && typeof maybeEnvelope.success === "boolean") {
		if (!maybeEnvelope.success) {
			const errMsg = typeof maybeEnvelope.error === "string" ? maybeEnvelope.error : "unknown error";
			throw new Error(`capabilities response: ${errMsg}`);
		}
		return extractCapability(maybeEnvelope.data);
	}

	return extractCapability(body);
}

function extractCapability(raw: unknown): CloudAgentCapability {
	if (raw === null || typeof raw !== "object") {
		throw new Error("capabilities response: data payload must be an object");
	}
	const obj = raw as { cloudAgentAllowed?: unknown; reason?: unknown };
	if (typeof obj.cloudAgentAllowed !== "boolean") {
		throw new Error("capabilities response: cloudAgentAllowed must be boolean");
	}
	return {
		cloudAgentAllowed: obj.cloudAgentAllowed,
		reason: typeof obj.reason === "string" ? obj.reason : "",
	};
}
