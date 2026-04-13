import { z } from "zod";

// ---------------------------------------------------------------------------
// Cloud-platform Instance API Types — A4
// @phase MVP
// @prd-section 4, 15.6
// ---------------------------------------------------------------------------

/**
 * Instance types supported by cloud-platform.
 * For cloud-backed Kanban task execution, only "task-runner" is used.
 */
export const cloudInstanceTypeSchema = z.enum(["task-runner", "acp", "webook"]);
export type CloudInstanceType = z.infer<typeof cloudInstanceTypeSchema>;

/**
 * States reported by cloud-platform for a provisioned instance.
 *
 * These are the **cloud-platform-side** states returned by
 * `GET /instances/{instance_id}`.  They are distinct from the Kanban
 * lifecycle states defined in `cloud-execution-lifecycle.ts`.
 *
 * Source: PRD Section 4 (Sandbox Lifecycle) + Section 15.5 code-grounded
 * reconciliation notes listing the current API values:
 *   provisioning, starting, ready, unhealthy, failed
 *
 * The PRD Section 4 diagram also defines the target states:
 *   requested, creating, ready, executing, stopping, terminated
 *
 * We accept both the currently verified API values and the target values
 * so the client is forward-compatible without breaking existing behaviour.
 */
export const cloudInstanceStateSchema = z.enum([
	// Currently verified cloud-platform API values (Section 15.5 notes)
	"provisioning",
	"starting",
	"ready",
	"unhealthy",
	"failed",
	// Target lifecycle values from PRD Section 4
	"requested",
	"creating",
	"executing",
	"stopping",
	"terminated",
]);
export type CloudInstanceState = z.infer<typeof cloudInstanceStateSchema>;

// ---------------------------------------------------------------------------
// Request / Response Schemas (matching cloud-platform API contract)
// ---------------------------------------------------------------------------

/**
 * POST /instances/ request body.
 * Per PRD Section 15.3 — Bridge A: Create instance.
 */
export const cloudInstanceCreateRequestSchema = z.object({
	user_id: z.string().min(1),
	repo_url: z.string().min(1),
	api_key: z.string().min(1),
	instance_type: cloudInstanceTypeSchema,
	github_pat: z.string().nullable().optional(),
	pr_base_branch: z.string().default("main"),
	starting_commit_sha: z.string().optional(),
	attempt_number: z.number().int().positive().optional(),
	worktree_intent: z.string().optional(),
});
export type CloudInstanceCreateRequest = z.infer<typeof cloudInstanceCreateRequestSchema>;

/**
 * POST /instances/ response body (201 Created).
 */
export const cloudInstanceCreatedResponseSchema = z.object({
	instance_id: z.string().min(1),
	user_id: z.string().min(1),
	namespace: z.string().min(1),
	hostname: z.string().min(1),
});
export type CloudInstanceCreatedResponse = z.infer<typeof cloudInstanceCreatedResponseSchema>;

/**
 * GET /instances/{id} response body.
 */
export const cloudInstanceStatusResponseSchema = z.object({
	instance_id: z.string().min(1),
	user_id: z.string().min(1),
	namespace: z.string().min(1),
	state: cloudInstanceStateSchema,
	hostname: z.string().min(1),
});
export type CloudInstanceStatusResponse = z.infer<typeof cloudInstanceStatusResponseSchema>;

/**
 * Backward-compatible alias used by the readiness poller (B2).
 * Prefer `CloudInstanceStatusResponse` in new code.
 */
export type CloudInstanceResponse = CloudInstanceStatusResponse;

/**
 * Backward-compatible minimal response schema used by the readiness poller.
 */
export const cloudInstanceResponseSchema = cloudInstanceStatusResponseSchema;

// ---------------------------------------------------------------------------
// Execution Intent (Kanban-side metadata for cloud-backed tasks)
// ---------------------------------------------------------------------------

/**
 * Execution mode for a task — local agent (existing path) or cloud agent.
 */
export const cloudExecutionModeSchema = z.enum(["local_agent", "cloud_agent"]);
export type CloudExecutionMode = z.infer<typeof cloudExecutionModeSchema>;

/**
 * Every task intended for cloud execution must carry explicit repo/branch/worktree
 * execution intent per PRD Section 15.13 and 15.14.
 *
 * This is the authoritative Kanban-side execution metadata that accompanies
 * instance creation requests and is persisted for end-to-end traceability.
 */
export const cloudExecutionIntentSchema = z.object({
	/** Remote repository URL the cloud runner should work against. */
	repo_url: z.string().min(1),
	/** Default base branch used when the sandbox prepares its worktree/branch flow. */
	base_branch: z.string().min(1),
	/** Feature branch naming intent as defined by Kanban naming rules. */
	feature_branch_intent: z.string().min(1),
	/** Worktree naming intent for the remote sandbox. */
	worktree_intent: z.string().min(1),
	/** Optional starting commit SHA to normalize workspace to before execution. */
	starting_commit_sha: z.string().optional(),
	/** Execution mode: local_agent or cloud_agent. */
	execution_mode: cloudExecutionModeSchema,
	/** Attempt number for this execution (1-based). */
	attempt_number: z.number().int().positive(),
});
export type CloudExecutionIntent = z.infer<typeof cloudExecutionIntentSchema>;

// ---------------------------------------------------------------------------
// Task-to-Instance Identity Mapping
// ---------------------------------------------------------------------------

/**
 * Maps a Kanban task to its provisioned cloud-platform instance.
 * Per PRD Section 15.3 — Kanban must persist this mapping.
 */
export const taskInstanceMappingSchema = z.object({
	task_id: z.string().min(1),
	instance_id: z.string().min(1),
	hostname: z.string().min(1),
	namespace: z.string().min(1),
	attempt_number: z.number().int().positive(),
	idempotency_key: z.string().min(1),
	execution_intent: cloudExecutionIntentSchema,
	created_at: z.string().min(1),
});
export type TaskInstanceMapping = z.infer<typeof taskInstanceMappingSchema>;

// ---------------------------------------------------------------------------
// Cloud-platform Error Envelope
// ---------------------------------------------------------------------------

/**
 * Cloud-platform error response shape per PRD Section 5.1.1.
 */
export const cloudErrorResponseSchema = z.object({
	error: z
		.object({
			code: z.string().optional(),
			message: z.string(),
			details: z.unknown().optional(),
		})
		.optional(),
	detail: z.string().optional(),
	message: z.string().optional(),
});

/**
 * Error thrown when a cloud-platform API call fails.
 */
export class CloudInstanceClientError extends Error {
	readonly statusCode: number;
	readonly retryable: boolean;
	readonly errorCode: string | undefined;

	constructor(opts: {
		message: string;
		statusCode: number;
		retryable: boolean;
		errorCode?: string;
	}) {
		super(opts.message);
		this.name = "CloudInstanceClientError";
		this.statusCode = opts.statusCode;
		this.retryable = opts.retryable;
		this.errorCode = opts.errorCode;
	}
}

// ---------------------------------------------------------------------------
// Retry Configuration (PRD Section 15.6)
// ---------------------------------------------------------------------------

export interface RetryConfig {
	/** Maximum number of retry attempts (not counting the initial attempt). */
	readonly maxRetries: number;
	/** Base delay in milliseconds for exponential backoff. */
	readonly baseDelayMs: number;
	/** Maximum delay in milliseconds between retries. */
	readonly maxDelayMs: number;
	/** Request timeout in milliseconds. */
	readonly timeoutMs: number;
}

/**
 * Default retry configs per PRD Section 15.6 Retry and timeout matrix.
 */
export const RETRY_CONFIGS = {
	createInstance: {
		maxRetries: 2,
		baseDelayMs: 1000,
		maxDelayMs: 10_000,
		timeoutMs: 180_000, // 3 min
	},
	getInstance: {
		maxRetries: 2,
		baseDelayMs: 500,
		maxDelayMs: 5_000,
		timeoutMs: 30_000, // 30 sec
	},
	deleteInstance: {
		maxRetries: 3,
		baseDelayMs: 1000,
		maxDelayMs: 15_000,
		timeoutMs: 120_000, // 2 min
	},
} as const satisfies Record<string, RetryConfig>;

// ---------------------------------------------------------------------------
// Injectable Client Interface
// ---------------------------------------------------------------------------

/**
 * Injectable interface for the cloud instance client.
 * Implementations must support create, get, and delete operations.
 * This interface is the primary extension point for testing (mock) and
 * production (HTTP) implementations.
 */
export interface CloudInstanceClient {
	/**
	 * Create a new task-runner instance for a task.
	 *
	 * @param request - Instance creation parameters matching cloud-platform API.
	 * @param options - Idempotency key and execution context.
	 * @returns Created instance details and the task-to-instance mapping.
	 */
	createInstance(request: CloudInstanceCreateRequest, options: CreateInstanceOptions): Promise<CreateInstanceResult>;

	/**
	 * Query instance status/readiness.
	 *
	 * @param instanceId - Cloud-platform instance ID.
	 * @returns Instance status including current state.
	 */
	getInstance(instanceId: string, signal?: AbortSignal): Promise<CloudInstanceStatusResponse>;

	/**
	 * Tear down an instance.
	 *
	 * @param instanceId - Cloud-platform instance ID.
	 */
	deleteInstance(instanceId: string): Promise<void>;
}

export interface CreateInstanceOptions {
	/** Kanban task ID to map to the created instance. */
	readonly taskId: string;
	/** Idempotency key for the create request. */
	readonly idempotencyKey: string;
	/** Full execution intent metadata for this task. */
	readonly executionIntent: CloudExecutionIntent;
}

export interface CreateInstanceResult {
	/** Response from cloud-platform. */
	readonly response: CloudInstanceCreatedResponse;
	/** Persisted task-to-instance identity mapping. */
	readonly mapping: TaskInstanceMapping;
}

// ---------------------------------------------------------------------------
// HTTP Client Configuration
// ---------------------------------------------------------------------------

export interface CloudInstanceClientConfig {
	/** Base URL for the cloud-platform instance API. */
	readonly baseUrl: string;
	/** Service-to-service auth credential (Bearer token). */
	readonly serviceCredential: string;
	/** Override retry configs (optional, defaults per PRD 15.6). */
	readonly retryConfigs?: Partial<Record<keyof typeof RETRY_CONFIGS, Partial<RetryConfig>>>;
	/** Custom fetch function for dependency injection / testing. */
	readonly fetch?: typeof globalThis.fetch;
	/** Custom delay function for dependency injection / testing. */
	readonly delay?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// HTTP Client Implementation
// ---------------------------------------------------------------------------

/**
 * Production HTTP client for the cloud-platform instance API (Bridge A).
 *
 * Implements typed create/get/delete operations with:
 * - Service-to-service auth via Bearer token
 * - Idempotency keys on create requests
 * - Retry with exponential backoff per PRD Section 15.6
 * - Task-to-instance identity mapping
 */
export class CloudInstanceHttpClient implements CloudInstanceClient {
	private readonly baseUrl: string;
	private readonly serviceCredential: string;
	private readonly retryConfigs: Record<keyof typeof RETRY_CONFIGS, RetryConfig>;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly delayFn: (ms: number) => Promise<void>;

	constructor(config: CloudInstanceClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.serviceCredential = config.serviceCredential;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.delayFn = config.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

		this.retryConfigs = {
			createInstance: {
				...RETRY_CONFIGS.createInstance,
				...config.retryConfigs?.createInstance,
			},
			getInstance: {
				...RETRY_CONFIGS.getInstance,
				...config.retryConfigs?.getInstance,
			},
			deleteInstance: {
				...RETRY_CONFIGS.deleteInstance,
				...config.retryConfigs?.deleteInstance,
			},
		};
	}

	async createInstance(
		request: CloudInstanceCreateRequest,
		options: CreateInstanceOptions,
	): Promise<CreateInstanceResult> {
		const validated = cloudInstanceCreateRequestSchema.parse(request);
		const retryConfig = this.retryConfigs.createInstance;

		const response = await this.executeWithRetry(async (signal) => {
			return this.fetchFn(`${this.baseUrl}/instances/`, {
				method: "POST",
				headers: this.buildHeaders(options.idempotencyKey),
				body: JSON.stringify(validated),
				signal,
			});
		}, retryConfig);

		const body = await response.json();
		const created = cloudInstanceCreatedResponseSchema.parse(body);

		const mapping: TaskInstanceMapping = {
			task_id: options.taskId,
			instance_id: created.instance_id,
			hostname: created.hostname,
			namespace: created.namespace,
			attempt_number: options.executionIntent.attempt_number,
			idempotency_key: options.idempotencyKey,
			execution_intent: options.executionIntent,
			created_at: new Date().toISOString(),
		};

		return { response: created, mapping };
	}

	async getInstance(instanceId: string, _signal?: AbortSignal): Promise<CloudInstanceStatusResponse> {
		const retryConfig = this.retryConfigs.getInstance;

		const response = await this.executeWithRetry(async (signal) => {
			return this.fetchFn(`${this.baseUrl}/instances/${encodeURIComponent(instanceId)}`, {
				method: "GET",
				headers: this.buildHeaders(),
				signal,
			});
		}, retryConfig);

		const body = await response.json();
		return cloudInstanceStatusResponseSchema.parse(body);
	}

	async deleteInstance(instanceId: string): Promise<void> {
		const retryConfig = this.retryConfigs.deleteInstance;

		await this.executeWithRetry(async (signal) => {
			return this.fetchFn(`${this.baseUrl}/instances/${encodeURIComponent(instanceId)}`, {
				method: "DELETE",
				headers: this.buildHeaders(),
				signal,
			});
		}, retryConfig);
	}

	// -----------------------------------------------------------------------
	// Internal Helpers
	// -----------------------------------------------------------------------

	private buildHeaders(idempotencyKey?: string): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.serviceCredential}`,
		};
		if (idempotencyKey) {
			headers["Idempotency-Key"] = idempotencyKey;
		}
		return headers;
	}

	private async executeWithRetry(
		operation: (signal: AbortSignal) => Promise<Response>,
		config: RetryConfig,
	): Promise<Response> {
		let lastError: unknown;

		for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
			if (attempt > 0) {
				const delay = Math.min(config.baseDelayMs * 2 ** (attempt - 1), config.maxDelayMs);
				await this.delayFn(delay);
			}

			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

				let response: Response;
				try {
					response = await operation(controller.signal);
				} finally {
					clearTimeout(timeoutId);
				}

				if (response.ok || response.status === 204) {
					return response;
				}

				const error = await this.parseErrorResponse(response);

				// Non-retryable HTTP status codes — fail immediately
				if (!error.retryable) {
					throw error;
				}

				lastError = error;
			} catch (err) {
				if (err instanceof CloudInstanceClientError && !err.retryable) {
					throw err;
				}

				// Network errors and timeouts are retryable
				lastError = err;
			}
		}

		throw lastError;
	}

	private async parseErrorResponse(response: Response): Promise<CloudInstanceClientError> {
		const retryable = isRetryableStatusCode(response.status);

		let message = `Cloud instance API error: HTTP ${response.status}`;
		let errorCode: string | undefined;

		try {
			const body = await response.json();
			const parsed = cloudErrorResponseSchema.safeParse(body);
			if (parsed.success) {
				message = parsed.data.error?.message ?? parsed.data.detail ?? parsed.data.message ?? message;
				errorCode = parsed.data.error?.code;
			}
		} catch {
			// Response body could not be parsed; use default message.
		}

		return new CloudInstanceClientError({
			message,
			statusCode: response.status,
			retryable,
			errorCode,
		});
	}
}

// ---------------------------------------------------------------------------
// Retry-safe status code classification
// ---------------------------------------------------------------------------

/**
 * Determines if an HTTP status code is safe to retry.
 * Per PRD Section 15.6 — retry only on transient server/network errors.
 *
 * - 4xx: Not retryable (client errors), except 408 and 429
 * - 5xx: Retryable (server errors)
 * - 409: Not retryable — runner rejects concurrent requests
 */
export function isRetryableStatusCode(statusCode: number): boolean {
	if (statusCode === 408 || statusCode === 429) {
		return true;
	}
	if (statusCode >= 400 && statusCode < 500) {
		return false;
	}
	if (statusCode >= 500) {
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Idempotency Key Generation
// ---------------------------------------------------------------------------

/**
 * Generate an idempotency key for a create instance request.
 * Format: `kanban:{taskId}:{attemptNumber}:{random}`
 *
 * This ensures that retried create requests for the same task and attempt
 * produce unique keys, while the task/attempt context is embedded for
 * debugging and correlation.
 */
export function generateIdempotencyKey(taskId: string, attemptNumber: number): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `kanban:${taskId}:${attemptNumber}:${random}`;
}
