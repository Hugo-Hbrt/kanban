// ---------------------------------------------------------------------------
// Cloud Governance Client — D-track
// @phase Phase2
// @prd-section 6, 15.6
// ---------------------------------------------------------------------------
//
// Makes real HTTP calls to core-platform governance endpoints:
//   - POST /api/v1/execution/authorize   — policy check authorization (D1)
//   - POST /api/v1/usage/reservations    — budget reservation (D2)
//   - POST /api/v1/usage/events          — usage event reporting (D2)
//   - POST /api/v1/audit/events          — audit trail events (D3)
//
// Schemas aligned with core-platform/apps/backend/core-api/internal/domain/governance/types.go
// ---------------------------------------------------------------------------

import { z } from "zod";

import type { CloudAuthProvider } from "./cloud-auth-provider";
import { EnvironmentCloudAuthProvider } from "./cloud-auth-provider";

// ---------------------------------------------------------------------------
// Shared Types (matches core-platform ExecutionContext)
// ---------------------------------------------------------------------------

export const executionContextSchema = z.object({
	repoUrl: z.string().optional().default(""),
	baseBranch: z.string().optional().default(""),
	featureBranchIntent: z.string().optional().default(""),
	worktreeIntent: z.string().optional().default(""),
});
export type ExecutionContext = z.infer<typeof executionContextSchema>;

// ---------------------------------------------------------------------------
// D1 — Authorization Request / Response Schemas
// Matches: core-platform AuthorizeExecutionRequest
// ---------------------------------------------------------------------------

export const taskSpecSchema = z.object({
	type: z.string().min(1),
	image: z.string().min(1),
	tools: z.array(z.string()).optional(),
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;

export const requestedLimitsSchema = z.object({
	maxComputeSeconds: z.number().int().positive(),
	maxTokenBudget: z.number().int().positive(),
});
export type RequestedLimits = z.infer<typeof requestedLimitsSchema>;

export const authorizeRequestSchema = z.object({
	orgId: z.string().min(1),
	userId: z.string().min(1),
	projectId: z.string().min(1),
	taskId: z.string().min(1),
	executionMode: z.string().min(1),
	taskSpec: taskSpecSchema,
	requestedLimits: requestedLimitsSchema,
	executionContext: executionContextSchema.optional(),
});
export type AuthorizeRequest = z.infer<typeof authorizeRequestSchema>;

export const authorizeResponseSchema = z.object({
	allowed: z.boolean(),
	policySnapshotId: z.string().optional(),
	denialReason: z.string().optional(),
});

/** Normalized caller-facing response so existing consumers don't break. */
export type AuthorizeResponse = {
	decision: "authorized" | "denied";
	reason?: string;
	policySnapshotId?: string;
};

// ---------------------------------------------------------------------------
// D2 — Budget Reservation Request / Response Schemas
// Matches: core-platform ReserveBudgetRequest / ReserveBudgetResult
// ---------------------------------------------------------------------------

export const reserveBudgetRequestSchema = z.object({
	taskId: z.string().min(1),
	orgId: z.string().min(1),
	maxComputeSeconds: z.number().int().positive(),
	maxTokenBudget: z.number().int().positive(),
	maxCostUsd: z.number().positive(),
	executionMode: z.string().optional(),
	executionContext: executionContextSchema.optional(),
});
export type ReserveBudgetRequest = z.infer<typeof reserveBudgetRequestSchema>;

export const reserveBudgetResponseSchema = z.object({
	reservationId: z.string(),
	expiresAt: z.string(),
});
export type ReserveBudgetResponse = z.infer<typeof reserveBudgetResponseSchema>;

// ---------------------------------------------------------------------------
// D2 — Usage Event Request / Response Schemas
// Matches: core-platform UsageEventRequest / UsageEventResult
// ---------------------------------------------------------------------------

export const usageEventRequestSchema = z.object({
	taskId: z.string().min(1),
	orgId: z.string().min(1),
	userId: z.string().min(1),
	executionMode: z.string().min(1),
	cpuSeconds: z.number().nonnegative().optional().default(0),
	memoryGbSeconds: z.number().nonnegative().optional().default(0),
	tokensIn: z.number().int().nonnegative().optional(),
	tokensOut: z.number().int().nonnegative().optional(),
	storageGbHours: z.number().nonnegative().optional().default(0),
	costUsd: z.number().nonnegative().optional().default(0),
	reservationId: z.string().optional(),
	idempotencyKey: z.string().optional(),
	executionContext: executionContextSchema.optional(),
});
export type UsageEventRequest = z.input<typeof usageEventRequestSchema>;

export const usageEventResponseSchema = z.object({
	accepted: z.boolean(),
	eventId: z.string().optional(),
	duplicate: z.boolean().optional(),
	budgetWarning: z.string().optional(),
});
export type UsageEventResponse = z.infer<typeof usageEventResponseSchema>;

// ---------------------------------------------------------------------------
// D3 — Audit Event Request / Response Schemas
// Matches: core-platform AuditEventRequest / AuditEventResult
// ---------------------------------------------------------------------------

export const auditActorSchema = z.object({
	type: z.string().min(1),
	id: z.string().min(1),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditResourceSchema = z.object({
	type: z.string().min(1),
	id: z.string().min(1),
});
export type AuditResource = z.infer<typeof auditResourceSchema>;

export const auditEventMetadataSchema = z.object({
	sandboxId: z.string().optional(),
	durationSeconds: z.number().optional(),
	executionMode: z.string().optional(),
	repoUrl: z.string().optional(),
	baseBranch: z.string().optional(),
	featureBranchIntent: z.string().optional(),
	worktreeIntent: z.string().optional(),
	policySnapshotId: z.string().optional(),
});
export type AuditEventMetadata = z.infer<typeof auditEventMetadataSchema>;

export const auditEventRequestSchema = z.object({
	actor: auditActorSchema,
	action: z.string().min(1),
	resource: auditResourceSchema,
	result: z.string().min(1),
	metadata: auditEventMetadataSchema.optional(),
	orgId: z.string().optional(),
	userId: z.string().optional(),
	projectId: z.string().optional(),
	taskId: z.string().optional(),
	idempotencyKey: z.string().optional(),
});
export type AuditEventRequest = z.infer<typeof auditEventRequestSchema>;

export const auditEventResponseSchema = z.object({
	accepted: z.boolean(),
	eventId: z.string().optional(),
	duplicate: z.boolean().optional(),
});
export type AuditEventResponse = z.infer<typeof auditEventResponseSchema>;

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class GovernanceClientError extends Error {
	readonly statusCode: number;
	readonly retryable: boolean;
	readonly errorCode: string | undefined;

	constructor(opts: { message: string; statusCode: number; retryable: boolean; errorCode?: string }) {
		super(opts.message);
		this.name = "GovernanceClientError";
		this.statusCode = opts.statusCode;
		this.retryable = opts.retryable;
		this.errorCode = opts.errorCode;
	}
}

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

export interface GovernanceRetryConfig {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly timeoutMs: number;
}

export const DEFAULT_GOVERNANCE_RETRY_CONFIGS = {
	authorize: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	reservation: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	usage: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	audit: { maxRetries: 1, baseDelayMs: 300, maxDelayMs: 3_000, timeoutMs: 5_000 },
} as const satisfies Record<string, GovernanceRetryConfig>;

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface GovernanceClientConfig {
	readonly baseUrl: string;
	/** @deprecated Use `authProvider` instead. Kept for backward compatibility. */
	readonly authToken?: string;
	/** Auth provider for outbound calls. Takes precedence over `authToken`. */
	readonly authProvider?: CloudAuthProvider;
	/** When true, unreachable governance returns 'authorized'. @default true */
	readonly failOpen: boolean;
	/** Service name sent in X-Service-Name header. @default "kanban" */
	readonly serviceName?: string;
	readonly retryConfigs?: Partial<
		Record<keyof typeof DEFAULT_GOVERNANCE_RETRY_CONFIGS, Partial<GovernanceRetryConfig>>
	>;
	readonly fetch?: typeof globalThis.fetch;
	readonly delay?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export interface GovernanceLogger {
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: GovernanceLogger = { info: () => {}, warn: () => {}, error: () => {} };

// ---------------------------------------------------------------------------
// GovernanceClient Interface
// ---------------------------------------------------------------------------

export interface GovernanceClient {
	checkAuthorization(request: AuthorizeRequest, signal?: AbortSignal): Promise<AuthorizeResponse>;
	reserveBudget(request: ReserveBudgetRequest, signal?: AbortSignal): Promise<ReserveBudgetResponse>;
	reportUsage(request: UsageEventRequest, signal?: AbortSignal): Promise<UsageEventResponse>;
	reportAudit(request: AuditEventRequest, signal?: AbortSignal): Promise<AuditEventResponse>;
}

// ---------------------------------------------------------------------------
// Retry-safe status code classification
// ---------------------------------------------------------------------------

export function isGovernanceRetryableStatus(statusCode: number): boolean {
	if (statusCode === 408 || statusCode === 429) return true;
	if (statusCode >= 400 && statusCode < 500) return false;
	if (statusCode >= 500) return true;
	return false;
}

// ---------------------------------------------------------------------------
// HTTP Client Implementation
// ---------------------------------------------------------------------------

export class GovernanceHttpClient implements GovernanceClient {
	private readonly baseUrl: string;
	private readonly authProvider: CloudAuthProvider;
	private readonly failOpen: boolean;
	private readonly serviceName: string;
	private readonly retryConfigs: Record<keyof typeof DEFAULT_GOVERNANCE_RETRY_CONFIGS, GovernanceRetryConfig>;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly delayFn: (ms: number) => Promise<void>;
	private readonly logger: GovernanceLogger;

	constructor(config: GovernanceClientConfig, logger: GovernanceLogger = noopLogger) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authProvider = config.authProvider ?? new EnvironmentCloudAuthProvider({ apiKey: config.authToken ?? "" });
		this.failOpen = config.failOpen;
		this.serviceName = config.serviceName ?? "kanban";
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.delayFn = config.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.logger = logger;
		this.retryConfigs = {
			authorize: { ...DEFAULT_GOVERNANCE_RETRY_CONFIGS.authorize, ...config.retryConfigs?.authorize },
			reservation: { ...DEFAULT_GOVERNANCE_RETRY_CONFIGS.reservation, ...config.retryConfigs?.reservation },
			usage: { ...DEFAULT_GOVERNANCE_RETRY_CONFIGS.usage, ...config.retryConfigs?.usage },
			audit: { ...DEFAULT_GOVERNANCE_RETRY_CONFIGS.audit, ...config.retryConfigs?.audit },
		};
	}

	async checkAuthorization(request: AuthorizeRequest, signal?: AbortSignal): Promise<AuthorizeResponse> {
		const validated = authorizeRequestSchema.parse(request);
		try {
			const response = await this.executeWithRetry(
				async (sig) =>
					this.fetchFn(`${this.baseUrl}/api/v1/execution/authorize`, {
						method: "POST",
						headers: await this.buildHeaders(),
						body: JSON.stringify(validated),
						signal: sig,
					}),
				this.retryConfigs.authorize,
				signal,
			);
			const body = await response.json();
			const data = this.unwrapResponse(body);
			const parsed = authorizeResponseSchema.parse(data);
			return {
				decision: parsed.allowed ? "authorized" : "denied",
				reason: parsed.denialReason,
				policySnapshotId: parsed.policySnapshotId,
			};
		} catch (e) {
			this.logger.error("Governance authorization check failed", {
				taskId: request.taskId,
				error: e instanceof Error ? e.message : String(e),
				failOpen: this.failOpen,
			});
			if (this.failOpen) {
				this.logger.warn("Fail-open: returning authorized despite governance error", {
					taskId: request.taskId,
				});
				return { decision: "authorized", reason: "fail-open: governance unreachable" };
			}
			return {
				decision: "denied",
				reason: `Governance unreachable: ${e instanceof Error ? e.message : String(e)}`,
			};
		}
	}

	async reserveBudget(request: ReserveBudgetRequest, signal?: AbortSignal): Promise<ReserveBudgetResponse> {
		const validated = reserveBudgetRequestSchema.parse(request);
		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v1/usage/reservations`, {
					method: "POST",
					headers: await this.buildHeaders(),
					body: JSON.stringify(validated),
					signal: sig,
				}),
			this.retryConfigs.reservation,
			signal,
		);
		const body = await response.json();
		return reserveBudgetResponseSchema.parse(this.unwrapResponse(body));
	}

	async reportUsage(request: UsageEventRequest, signal?: AbortSignal): Promise<UsageEventResponse> {
		const validated = usageEventRequestSchema.parse(request);
		try {
			const response = await this.executeWithRetry(
				async (sig) =>
					this.fetchFn(`${this.baseUrl}/api/v1/usage/events`, {
						method: "POST",
						headers: await this.buildHeaders(),
						body: JSON.stringify(validated),
						signal: sig,
					}),
				this.retryConfigs.usage,
				signal,
			);
			const body = await response.json();
			return usageEventResponseSchema.parse(this.unwrapResponse(body));
		} catch (e) {
			this.logger.error("Governance usage event report failed", {
				taskId: request.taskId,
				error: e instanceof Error ? e.message : String(e),
			});
			return { accepted: false };
		}
	}

	async reportAudit(request: AuditEventRequest, signal?: AbortSignal): Promise<AuditEventResponse> {
		const validated = auditEventRequestSchema.parse(request);
		try {
			const response = await this.executeWithRetry(
				async (sig) =>
					this.fetchFn(`${this.baseUrl}/api/v1/audit/events`, {
						method: "POST",
						headers: await this.buildHeaders(),
						body: JSON.stringify(validated),
						signal: sig,
					}),
				this.retryConfigs.audit,
				signal,
			);
			const body = await response.json();
			return auditEventResponseSchema.parse(this.unwrapResponse(body));
		} catch (e) {
			this.logger.error("Governance audit event report failed", {
				taskId: request.taskId,
				error: e instanceof Error ? e.message : String(e),
			});
			return { accepted: false };
		}
	}

	private async buildHeaders(): Promise<Record<string, string>> {
		const authHeaders = await this.authProvider.getAuthHeaders();
		return {
			"Content-Type": "application/json",
			...authHeaders,
			"X-Service-Name": this.serviceName,
		};
	}

	/**
	 * Unwrap core-platform response envelope `{ data, success, error }`.
	 * Returns `body.data` when the wrapper is present, or `body` as-is
	 * for backward compatibility with unwrapped responses.
	 */
	private unwrapResponse(body: unknown): unknown {
		if (
			body !== null &&
			typeof body === "object" &&
			"data" in body &&
			"success" in body
		) {
			const envelope = body as { data: unknown; success: boolean; error?: string };
			if (!envelope.success && envelope.error) {
				throw new GovernanceClientError({
					message: `Governance API returned error: ${envelope.error}`,
					statusCode: 422,
					retryable: false,
				});
			}
			return envelope.data;
		}
		return body;
	}

	private async executeWithRetry(
		operation: (signal: AbortSignal) => Promise<Response>,
		config: GovernanceRetryConfig,
		externalSignal?: AbortSignal,
	): Promise<Response> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
			if (externalSignal?.aborted) throw new Error("Request aborted");
			if (attempt > 0) {
				const delay = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
				await this.delayFn(delay);
			}
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
				const onAbort = () => controller.abort();
				externalSignal?.addEventListener("abort", onAbort, { once: true });
				let response: Response;
				try {
					response = await operation(controller.signal);
				} finally {
					clearTimeout(timeoutId);
					externalSignal?.removeEventListener("abort", onAbort);
				}
				if (response.ok) return response;
				const retryable = isGovernanceRetryableStatus(response.status);
				if (!retryable) {
					throw new GovernanceClientError({
						message: `Governance API error: HTTP ${response.status}`,
						statusCode: response.status,
						retryable: false,
					});
				}
				lastError = new GovernanceClientError({
					message: `Governance API error: HTTP ${response.status}`,
					statusCode: response.status,
					retryable: true,
				});
			} catch (err) {
				if (err instanceof GovernanceClientError && !err.retryable) throw err;
				lastError = err;
			}
		}
		throw lastError;
	}
}

// ---------------------------------------------------------------------------
// Configuration from Environment
// ---------------------------------------------------------------------------

export const GOVERNANCE_BASE_URL_ENV = "KANBAN_GOVERNANCE_BASE_URL";
export const GOVERNANCE_AUTH_TOKEN_ENV = "KANBAN_GOVERNANCE_AUTH_TOKEN";
export const GOVERNANCE_FAIL_OPEN_ENV = "KANBAN_GOVERNANCE_FAIL_OPEN";

/**
 * Parse governance client configuration from environment variables.
 * Returns `null` if the required base URL is not configured.
 */
export function parseGovernanceConfig(
	env: Record<string, string | undefined>,
	overrides?: Partial<GovernanceClientConfig>,
): GovernanceClientConfig | null {
	const baseUrl = overrides?.baseUrl ?? env[GOVERNANCE_BASE_URL_ENV];
	if (!baseUrl) return null;
	const authToken = overrides?.authToken ?? env[GOVERNANCE_AUTH_TOKEN_ENV] ?? "";
	const failOpenEnv = env[GOVERNANCE_FAIL_OPEN_ENV];
	const failOpen = overrides?.failOpen ?? (failOpenEnv !== undefined ? failOpenEnv !== "false" : true);
	// Use provided authProvider, or fall back to env-based provider with the token
	const authProvider = overrides?.authProvider ?? new EnvironmentCloudAuthProvider({ apiKey: authToken });
	return { baseUrl, authToken, authProvider, failOpen, ...overrides };
}
