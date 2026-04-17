// ---------------------------------------------------------------------------
// Cloud Execution Client — kanban → core-api (/instances) → pod (direct)
// ---------------------------------------------------------------------------
//
// Architecture:
//   kanban → core-api POST   /api/v2/cloud-platform/instances        (provision)
//   kanban → core-api GET    /api/v2/cloud-platform/instances/:id    (poll ready)
//   kanban → core-api DELETE /api/v2/cloud-platform/instances/:id    (teardown/cancel)
//   kanban → pod      POST   https://<hostname>/run                   (start work)
//   kanban → pod      GET    https://<hostname>/run/status            (poll progress)
//
// The pod does not call back into kanban. Status and result are pulled.
// `executionId` returned to callers is the same as the cloud-platform
// `instanceId`, so we have a single identifier end-to-end.
// ---------------------------------------------------------------------------

import type { CloudAuthProvider } from "./cloud-auth-provider";
import {
	type ExecutionCreateRequest,
	type ExecutionCreateResponse,
	type ExecutionLogsResponse,
	type ExecutionStatusResponse,
	executionCreateRequestSchema,
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
// Provision Polling Config
// ---------------------------------------------------------------------------

export interface ProvisionPollingConfig {
	readonly pollIntervalMs: number;
	readonly timeoutMs: number;
}

export const DEFAULT_PROVISION_POLLING_CONFIG: Readonly<ProvisionPollingConfig> = {
	pollIntervalMs: 2_000,
	timeoutMs: 120_000,
};

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface CloudPlatformExecutionClientConfig {
	/** core-api base URL, e.g. https://api.cline.bot */
	readonly baseUrl: string;
	/** Auth provider supplying the user's `sk_` token (Bearer) for core-api + pod. */
	readonly authProvider: CloudAuthProvider;
	/** GitHub PAT used for cloning the repo + pushing PR branches inside the pod. */
	readonly githubPat?: string;
	/** Override scheme for pod URLs (default "https"). Useful for local dev. */
	readonly podScheme?: "http" | "https";
	/** Override pod port (default unset → default 443/80 from scheme). */
	readonly podPort?: number;
	readonly retryConfigs?: Partial<
		Record<keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS, Partial<ExecutionClientRetryConfig>>
	>;
	readonly provisionPollingConfig?: Partial<ProvisionPollingConfig>;
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
// Pod /run + /run/status contract (matches apps/task-runner/runner/main.go)
// ---------------------------------------------------------------------------

interface PodRunRequest {
	prompt: string;
	task_id: string;
	attempt_number: number;
	branch_name: string;
	base_branch: string;
	starting_commit_sha: string;
	worktree_intent: string;
	reservation_id: string;
	result_upload_jwt: string;
	cloud_platform_url: string;
	execution_id: string;
}

interface PodStatusResponse {
	status: "idle" | "running" | "completed";
	task_id?: string;
	execution_id?: string;
	attempt_number?: number;
	started_at?: string;
	finished_at?: string;
	result?: {
		outcome?: string;
		exit_code?: number;
		summary?: string;
		pr_url?: string;
	};
	error?: {
		code?: string;
		message?: string;
	};
}

// ---------------------------------------------------------------------------
// Instance status response shape from core-api
// ---------------------------------------------------------------------------

interface CoreInstanceStatus {
	instanceId: string;
	state: string;
	instanceUrl: string;
	hostname: string;
	namespace: string;
}

// ---------------------------------------------------------------------------
// HTTP Client Implementation
// ---------------------------------------------------------------------------

export class CloudPlatformExecutionHttpClient implements CloudPlatformExecutionClient {
	private readonly baseUrl: string;
	private readonly authProvider: CloudAuthProvider;
	private readonly githubPat: string;
	private readonly podScheme: "http" | "https";
	private readonly podPort: number | undefined;
	private readonly retryConfigs: Record<
		keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS,
		ExecutionClientRetryConfig
	>;
	private readonly provisionPolling: ProvisionPollingConfig;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly delayFn: (ms: number) => Promise<void>;
	private readonly hostnameCache = new Map<string, string>();
	private readonly executionMeta = new Map<string, { taskId: string; attemptNumber: number }>();

	constructor(config: CloudPlatformExecutionClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authProvider = config.authProvider;
		this.githubPat = config.githubPat ?? "";
		this.podScheme = config.podScheme ?? "https";
		this.podPort = config.podPort;
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
		this.provisionPolling = { ...DEFAULT_PROVISION_POLLING_CONFIG, ...config.provisionPollingConfig };
	}

	async createExecution(request: ExecutionCreateRequest, signal?: AbortSignal): Promise<ExecutionCreateResponse> {
		const validated = executionCreateRequestSchema.parse(request);
		const authHeaders = await this.authProvider.getAuthHeaders();
		const apiKey = extractBearerToken(authHeaders);

		const provisionBody = {
			repoUrl: validated.repoUrl,
			apiKey,
			instanceType: "task-runner",
			githubPat: this.githubPat,
			prBaseBranch: validated.baseBranch,
		};

		const provisionResp = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/instances`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authHeaders, "X-Service-Name": "kanban" },
					body: JSON.stringify(provisionBody),
					signal: sig,
				}),
			this.retryConfigs.createExecution,
			signal,
		);
		const provisionData = this.unwrapResponse(await provisionResp.json()) as CoreInstanceStatus;
		if (!provisionData?.instanceId) {
			throw new CloudPlatformExecutionError({
				message: "core-api /instances returned no instanceId",
				statusCode: 502,
				retryable: false,
			});
		}
		const instanceId = provisionData.instanceId;

		const ready = await this.waitForInstanceReady(instanceId, authHeaders, signal);
		this.hostnameCache.set(instanceId, ready.hostname);
		this.executionMeta.set(instanceId, {
			taskId: validated.taskId,
			attemptNumber: validated.attemptNumber,
		});

		const runBody: PodRunRequest = {
			prompt: validated.prompt,
			task_id: validated.taskId,
			attempt_number: validated.attemptNumber,
			branch_name: validated.featureBranchIntent,
			base_branch: validated.baseBranch,
			starting_commit_sha: "",
			worktree_intent: validated.worktreeIntent,
			reservation_id: "",
			result_upload_jwt: "",
			cloud_platform_url: "",
			execution_id: instanceId,
		};

		await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(this.podUrl(ready.hostname, "/run"), {
					method: "POST",
					headers: { "Content-Type": "application/json", ...authHeaders },
					body: JSON.stringify(runBody),
					signal: sig,
				}),
			this.retryConfigs.createExecution,
			signal,
		);

		return {
			executionId: instanceId,
			status: "queued" as const,
			taskId: validated.taskId,
			attemptNumber: validated.attemptNumber,
			createdAt: new Date().toISOString(),
		};
	}

	async getExecutionStatus(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResponse> {
		const authHeaders = await this.authProvider.getAuthHeaders();
		const hostname = await this.resolveHostname(executionId, authHeaders, signal);

		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(this.podUrl(hostname, "/run/status"), {
					method: "GET",
					headers: { ...authHeaders },
					signal: sig,
				}),
			this.retryConfigs.getStatus,
			signal,
		);
		const pod = (await response.json()) as PodStatusResponse;
		return this.mapPodStatus(executionId, pod);
	}

	async getExecutionLogs(
		_executionId: string,
		_cursor?: string,
		_signal?: AbortSignal,
	): Promise<ExecutionLogsResponse> {
		return {
			executionId: _executionId,
			lines: [],
			nextCursor: null,
		};
	}

	async cancelExecution(executionId: string, signal?: AbortSignal): Promise<void> {
		const authHeaders = await this.authProvider.getAuthHeaders();
		await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(
					`${this.baseUrl}/api/v2/cloud-platform/instances/${encodeURIComponent(executionId)}`,
					{
						method: "DELETE",
						headers: { ...authHeaders, "X-Service-Name": "kanban" },
						signal: sig,
					},
				),
			this.retryConfigs.cancelExecution,
			signal,
		);
		this.hostnameCache.delete(executionId);
		this.executionMeta.delete(executionId);
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private podUrl(hostname: string, path: string): string {
		const host = this.podPort ? `${hostname}:${this.podPort}` : hostname;
		return `${this.podScheme}://${host}${path}`;
	}

	private async resolveHostname(
		instanceId: string,
		authHeaders: Record<string, string>,
		signal?: AbortSignal,
	): Promise<string> {
		const cached = this.hostnameCache.get(instanceId);
		if (cached) return cached;

		const resp = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(`${this.baseUrl}/api/v2/cloud-platform/instances/${encodeURIComponent(instanceId)}`, {
					method: "GET",
					headers: { ...authHeaders, "X-Service-Name": "kanban" },
					signal: sig,
				}),
			this.retryConfigs.getStatus,
			signal,
		);
		const data = this.unwrapResponse(await resp.json()) as CoreInstanceStatus;
		if (!data?.hostname) {
			throw new CloudPlatformExecutionError({
				message: `instance ${instanceId} has no hostname`,
				statusCode: 502,
				retryable: false,
			});
		}
		this.hostnameCache.set(instanceId, data.hostname);
		return data.hostname;
	}

	private async waitForInstanceReady(
		instanceId: string,
		authHeaders: Record<string, string>,
		signal?: AbortSignal,
	): Promise<CoreInstanceStatus> {
		const deadline = Date.now() + this.provisionPolling.timeoutMs;
		let last: CoreInstanceStatus | null = null;
		while (Date.now() < deadline) {
			if (signal?.aborted) {
				throw new CloudPlatformExecutionError({
					message: "provision wait aborted",
					statusCode: 0,
					retryable: false,
				});
			}
			const resp = await this.fetchFn(
				`${this.baseUrl}/api/v2/cloud-platform/instances/${encodeURIComponent(instanceId)}`,
				{ method: "GET", headers: { ...authHeaders, "X-Service-Name": "kanban" }, signal },
			);
			if (resp.ok) {
				const data = this.unwrapResponse(await resp.json()) as CoreInstanceStatus;
				last = data;
				if (data.state === "running" && data.hostname) return data;
				if (data.state === "failed" || data.state === "terminated") {
					throw new CloudPlatformExecutionError({
						message: `instance ${instanceId} entered terminal state ${data.state} during provisioning`,
						statusCode: 502,
						retryable: false,
					});
				}
			}
			await this.delayFn(this.provisionPolling.pollIntervalMs);
		}
		throw new CloudPlatformExecutionError({
			message: `instance ${instanceId} did not reach running in ${this.provisionPolling.timeoutMs}ms (last state: ${last?.state ?? "unknown"})`,
			statusCode: 504,
			retryable: false,
		});
	}

	private mapPodStatus(executionId: string, pod: PodStatusResponse): ExecutionStatusResponse {
		const meta = this.executionMeta.get(executionId);
		const taskId = pod.task_id ?? meta?.taskId ?? executionId;
		const attemptNumber = pod.attempt_number ?? meta?.attemptNumber ?? 1;

		let status: ExecutionStatusResponse["status"] = "queued";
		let result: ExecutionStatusResponse["result"] = null;
		let error: ExecutionStatusResponse["error"] = null;

		if (pod.status === "idle") status = "queued";
		else if (pod.status === "running") status = "running";
		else if (pod.status === "completed") {
			const exitCode = pod.result?.exit_code ?? 0;
			status = exitCode === 0 ? "succeeded" : "failed";
			if (pod.result) {
				result = {
					outcome: pod.result.outcome ?? (exitCode === 0 ? "success" : "failure"),
					exitCode,
					summary: pod.result.summary ?? pod.result.pr_url ?? "",
				};
			}
			if (pod.error) {
				error = {
					code: pod.error.code ?? "UNKNOWN",
					message: pod.error.message ?? "",
				};
			}
		}

		return {
			executionId,
			status,
			taskId,
			attemptNumber,
			requestedByUserId: "",
			orgId: "",
			projectId: "",
			startedAt: pod.started_at ?? null,
			finishedAt: pod.finished_at ?? null,
			result,
			error,
		};
	}

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
						else if (typeof errBody?.error === "string") message = errBody.error;
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
// Extract the user's sk_ token from the auth headers so we can put it in
// the ProvisionRequest body as `apiKey`. It's the same token either way —
// both core-api's Bearer auth and the pod's CLINE_API_KEY consume it.
// ---------------------------------------------------------------------------

function extractBearerToken(headers: Record<string, string>): string {
	const authz = headers["Authorization"] ?? headers["authorization"] ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(authz);
	return match?.[1] ?? "";
}

// ---------------------------------------------------------------------------
// Polling Configuration
// ---------------------------------------------------------------------------

export interface ExecutionPollingConfig {
	readonly pollIntervalMs: number;
	readonly maxPollDurationMs: number;
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

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "canceled"]);

export function isTerminalExecutionStatus(status: string): boolean {
	return TERMINAL_STATUSES.has(status);
}

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
			return { status: "error", reason: "Polling aborted", elapsedMs: Date.now() - startTime, pollCount };
		}
		const elapsed = Date.now() - startTime;
		if (elapsed >= config.maxPollDurationMs) {
			return { status: "timeout", lastResponse, elapsedMs: elapsed, pollCount };
		}
		pollCount++;
		try {
			const response = await client.getExecutionStatus(executionId, signal);
			lastResponse = response;
			consecutiveErrors = 0;
			if (onStatusUpdate) onStatusUpdate(response);
			if (isTerminalExecutionStatus(response.status)) {
				return { status: "terminal", response, elapsedMs: Date.now() - startTime, pollCount };
			}
			await delayFn(config.pollIntervalMs);
		} catch (e) {
			if (signal?.aborted) {
				return { status: "error", reason: "Polling aborted", elapsedMs: Date.now() - startTime, pollCount };
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
			await delayFn(Math.min(config.pollIntervalMs * 2 ** (consecutiveErrors - 1), 30_000));
		}
	}
}
