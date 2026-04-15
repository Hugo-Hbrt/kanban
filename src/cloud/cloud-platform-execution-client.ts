// ---------------------------------------------------------------------------
// Cloud Execution Client — KB-AUTH-3 / Boundary Realignment
// ---------------------------------------------------------------------------
//
// Routes execution CRUD through core-api (the public control plane), which
// proxies to cloud-platform's internal execution API.
//
// Endpoints (via core-api):
//   POST   /api/v2/cloud-platform/executions              — create execution
//   GET    /api/v2/cloud-platform/executions/{id}         — get execution status
//   GET    /api/v2/cloud-platform/executions/{id}/logs    — get execution logs
//   POST   /api/v2/cloud-platform/executions/{id}/cancel  — cancel execution
// ---------------------------------------------------------------------------

import type { CloudAuthProvider } from "./cloud-auth-provider";
import {
	type ExecutionCreateRequest,
	type ExecutionCreateResponse,
	type ExecutionLogsResponse,
	type ExecutionStatusResponse,
	executionCreateRequestSchema,
	executionCreateResponseSchema,
	executionLogsResponseSchema,
	executionStatusResponseSchema,
} from "./cloud-execution-contracts";

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

export class CloudPlatformExecutionError extends Error {
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
		this.name = "CloudPlatformExecutionError";
		this.statusCode = opts.statusCode;
		this.retryable = opts.retryable;
		this.errorCode = opts.errorCode;
	}
}

// ---------------------------------------------------------------------------
// Retry Configuration
// ---------------------------------------------------------------------------

export interface ExecutionClientRetryConfig {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly timeoutMs: number;
}

export const DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS = {
	createExecution: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, timeoutMs: 30_000 },
	getStatus: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	getLogs: { maxRetries: 1, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	cancelExecution: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
} as const satisfies Record<string, ExecutionClientRetryConfig>;

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface CloudPlatformExecutionClientConfig {
	readonly baseUrl: string;
	readonly authProvider: CloudAuthProvider;
	readonly retryConfigs?: Partial<
		Record<keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS, Partial<ExecutionClientRetryConfig>>
	>;
	readonly fetch?: typeof globalThis.fetch;
	readonly delay?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Client Interface
// ---------------------------------------------------------------------------

export interface CloudPlatformExecutionClient {
	createExecution(request: ExecutionCreateRequest, signal?: AbortSignal): Promise<ExecutionCreateResponse>;
	getExecutionStatus(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResponse>;
	getExecutionLogs(executionId: string, cursor?: string, signal?: AbortSignal): Promise<ExecutionLogsResponse>;
	cancelExecution(executionId: string, signal?: AbortSignal): Promise<void>;
}

// ---------------------------------------------------------------------------
// Retry-safe status code classification
// ---------------------------------------------------------------------------

function isRetryableStatus(statusCode: number): boolean {
	if (statusCode === 408 || statusCode === 429) return true;
	if (statusCode >= 400 && statusCode < 500) return false;
	if (statusCode >= 500) return true;
	return false;
}

// ---------------------------------------------------------------------------
// HTTP Client Implementation
// ---------------------------------------------------------------------------

export class CloudPlatformExecutionHttpClient implements CloudPlatformExecutionClient {
	private readonly baseUrl: string;
	private readonly authProvider: CloudAuthProvider;
	private readonly retryConfigs: Record<
		keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS,
		ExecutionClientRetryConfig
	>;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly delayFn: (ms: number) => Promise<void>;

	constructor(config: CloudPlatformExecutionClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authProvider = config.authProvider;
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.delayFn = config.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.retryConfigs = {
			createExecution: {
				...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.createExecution,
				...config.retryConfigs?.createExecution,
			},
			getStatus: { ...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.getStatus, ...config.retryConfigs?.getStatus },
			getLogs: { ...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.getLogs, ...config.retryConfigs?.getLogs },
			cancelExecution: {
				...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.cancelExecution,
				...config.retryConfigs?.cancelExecution,
			},
		};
	}

	async createExecution(request: ExecutionCreateRequest, signal?: AbortSignal): Promise<ExecutionCreateResponse> {
		const validated = executionCreateRequestSchema.parse(request);
		const headers = await this.buildHeaders();
		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/executions`, {
					method: "POST",
					headers,
					body: JSON.stringify(validated),
					signal: sig,
				}),
			this.retryConfigs.createExecution,
			signal,
		);
		const body = await response.json();
		const data = this.unwrapResponse(body);
		return executionCreateResponseSchema.parse(data);
	}

	async getExecutionStatus(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResponse> {
		const headers = await this.buildHeaders();
		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/executions/${encodeURIComponent(executionId)}`, {
					method: "GET",
					headers,
					signal: sig,
				}),
			this.retryConfigs.getStatus,
			signal,
		);
		const body = await response.json();
		const data = this.unwrapResponse(body);
		return executionStatusResponseSchema.parse(data);
	}

	async getExecutionLogs(executionId: string, cursor?: string, signal?: AbortSignal): Promise<ExecutionLogsResponse> {
		const headers = await this.buildHeaders();
		const url = new URL(`${this.baseUrl}/api/v2/cloud-platform/executions/${encodeURIComponent(executionId)}/logs`);
		if (cursor) url.searchParams.set("cursor", cursor);
		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(url.toString(), {
					method: "GET",
					headers,
					signal: sig,
				}),
			this.retryConfigs.getLogs,
			signal,
		);
		const body = await response.json();
		const data = this.unwrapResponse(body);
		return executionLogsResponseSchema.parse(data);
	}

	async cancelExecution(executionId: string, signal?: AbortSignal): Promise<void> {
		const headers = await this.buildHeaders();
		await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/executions/${encodeURIComponent(executionId)}/cancel`, {
					method: "POST",
					headers,
					signal: sig,
				}),
			this.retryConfigs.cancelExecution,
			signal,
		);
	}

	// -----------------------------------------------------------------------
	// Internal Helpers
	// -----------------------------------------------------------------------

	private async buildHeaders(): Promise<Record<string, string>> {
		const authHeaders = await this.authProvider.getAuthHeaders();
		return {
			"Content-Type": "application/json",
			...authHeaders,
			"X-Service-Name": "kanban",
		};
	}

	/**
	 * Unwrap cloud-platform response envelope `{ data, success, error }`.
	 */
	private unwrapResponse(body: unknown): unknown {
		if (body !== null && typeof body === "object" && "data" in body && "success" in body) {
			const envelope = body as { data: unknown; success: boolean; error?: string };
			if (!envelope.success && envelope.error) {
				throw new CloudPlatformExecutionError({
					message: `Cloud platform API error: ${envelope.error}`,
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
		config: ExecutionClientRetryConfig,
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
				if (response.ok || response.status === 204) return response;
				const retryable = isRetryableStatus(response.status);
				if (!retryable) {
					let message = `Cloud platform API error: HTTP ${response.status}`;
					try {
						const errBody = (await response.json()) as Record<string, unknown>;
						const errObj = errBody?.error as Record<string, unknown> | undefined;
						if (errObj?.message) message = String(errObj.message);
						else if (errBody?.message) message = String(errBody.message);
					} catch {
						/* use default message */
					}
					throw new CloudPlatformExecutionError({
						message,
						statusCode: response.status,
						retryable: false,
					});
				}
				lastError = new CloudPlatformExecutionError({
					message: `Cloud platform API error: HTTP ${response.status}`,
					statusCode: response.status,
					retryable: true,
				});
			} catch (err) {
				if (err instanceof CloudPlatformExecutionError && !err.retryable) throw err;
				lastError = err;
			}
		}
		throw lastError;
	}
}

// ---------------------------------------------------------------------------
// Polling Configuration
// ---------------------------------------------------------------------------

export interface ExecutionPollingConfig {
	/** Interval between status polls in milliseconds. @default 5_000 */
	readonly pollIntervalMs: number;
	/** Maximum total time to poll before giving up. @default 3_600_000 (1 hour) */
	readonly maxPollDurationMs: number;
	/** Maximum consecutive polling errors before giving up. @default 10 */
	readonly maxConsecutiveErrors: number;
}

export const DEFAULT_EXECUTION_POLLING_CONFIG: Readonly<ExecutionPollingConfig> = {
	pollIntervalMs: 5_000,
	maxPollDurationMs: 3_600_000,
	maxConsecutiveErrors: 10,
};

// ---------------------------------------------------------------------------
// Polling Result
// ---------------------------------------------------------------------------

export type ExecutionPollingOutcome =
	| {
			readonly status: "terminal";
			readonly response: ExecutionStatusResponse;
			readonly elapsedMs: number;
			readonly pollCount: number;
	  }
	| {
			readonly status: "timeout";
			readonly lastResponse: ExecutionStatusResponse | null;
			readonly elapsedMs: number;
			readonly pollCount: number;
	  }
	| {
			readonly status: "error";
			readonly reason: string;
			readonly elapsedMs: number;
			readonly pollCount: number;
	  };

// ---------------------------------------------------------------------------
// Terminal status check
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export function isTerminalExecutionStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

// ---------------------------------------------------------------------------
// Polling Function
// ---------------------------------------------------------------------------

/**
 * Poll cloud-platform execution status until a terminal state is reached.
 *
 * @param client - Cloud platform execution client
 * @param executionId - The execution to poll
 * @param config - Polling configuration
 * @param signal - Optional abort signal
 * @param onStatusUpdate - Optional callback for status updates during polling
 */
export async function pollExecutionStatus(
	client: CloudPlatformExecutionClient,
	executionId: string,
	config: ExecutionPollingConfig = DEFAULT_EXECUTION_POLLING_CONFIG,
	signal?: AbortSignal,
	onStatusUpdate?: (response: ExecutionStatusResponse) => void,
	delayFn: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<ExecutionPollingOutcome> {
	const startTime = Date.now();
	let pollCount = 0;
	let consecutiveErrors = 0;
	let lastResponse: ExecutionStatusResponse | null = null;

	while (true) {
		if (signal?.aborted) {
			return {
				status: "error",
				reason: "Polling aborted",
				elapsedMs: Date.now() - startTime,
				pollCount,
			};
		}

		const elapsed = Date.now() - startTime;
		if (elapsed >= config.maxPollDurationMs) {
			return {
				status: "timeout",
				lastResponse,
				elapsedMs: elapsed,
				pollCount,
			};
		}

		pollCount++;
		try {
			const response = await client.getExecutionStatus(executionId, signal);
			lastResponse = response;
			consecutiveErrors = 0;

			if (onStatusUpdate) {
				onStatusUpdate(response);
			}

			if (isTerminalExecutionStatus(response.status)) {
				return {
					status: "terminal",
					response,
					elapsedMs: Date.now() - startTime,
					pollCount,
				};
			}

			await delayFn(config.pollIntervalMs);
		} catch (e) {
			if (signal?.aborted) {
				return {
					status: "error",
					reason: "Polling aborted",
					elapsedMs: Date.now() - startTime,
					pollCount,
				};
			}

			consecutiveErrors++;
			if (consecutiveErrors >= config.maxConsecutiveErrors) {
				return {
					status: "error",
					reason: `Max consecutive errors reached (${consecutiveErrors}): ${e instanceof Error ? e.message : String(e)}`,
					elapsedMs: Date.now() - startTime,
					pollCount,
				};
			}

			// Backoff on error
			await delayFn(Math.min(config.pollIntervalMs * 2 ** (consecutiveErrors - 1), 30_000));
		}
	}
}
