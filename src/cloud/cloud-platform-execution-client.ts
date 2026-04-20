// ---------------------------------------------------------------------------
// Cloud Execution Client — kanban → core-api (/instances) → ACP pod
// ---------------------------------------------------------------------------
//
// Architecture (ACP pivot, assumes cloud/cloud-platform#6 has landed):
//   kanban → core-api POST   /api/v2/cloud-platform/instances        (provision)
//   kanban → core-api GET    /api/v2/cloud-platform/instances/:id    (poll instance lifecycle)
//   kanban → core-api DELETE /api/v2/cloud-platform/instances/:id    (teardown/cancel)
//
// `instanceType: "acp"` provisions a cline-base pod that exposes the ACP
// protocol over a WebSocket at `runtime.connectUrl`. Actual task execution
// (prompts, tool calls, completion signalling) flows over that WebSocket and
// is owned by CloudRuntimeClient — NOT by this HTTP client.
//
// This client's responsibilities are narrow:
//   - createExecution  : provision an ACP pod, wait for readiness, capture connectUrl
//   - getExecutionStatus: poll core-api for instance lifecycle state only
//                         (queued / running / failed / canceled). Task-level
//                         success/failure is reported by the WebSocket path.
//   - cancelExecution  : delete the pod
//   - getInstanceRuntime: expose the cached RuntimeInfo so the runtime client
//                         can open the WebSocket without a separate round-trip
//
// `executionId` returned to callers is the cloud-platform `instanceId`, so
// there is a single identifier end-to-end.
// ---------------------------------------------------------------------------

import type { CloudAuthProvider } from "./cloud-auth-provider";
import {
	type ExecutionCreateRequest,
	type ExecutionCreateResponse,
	type ExecutionStatusResponse,
	executionCreateRequestSchema,
} from "./cloud-execution-contracts";

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

export interface ExecutionClientRetryConfig {
	readonly maxRetries: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	readonly timeoutMs: number;
}

export const DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS = {
	createExecution: { maxRetries: 2, baseDelayMs: 1000, maxDelayMs: 10_000, timeoutMs: 30_000 },
	getStatus: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
	cancelExecution: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5_000, timeoutMs: 10_000 },
} as const satisfies Record<string, ExecutionClientRetryConfig>;

export interface ProvisionPollingConfig {
	readonly pollIntervalMs: number;
	readonly timeoutMs: number;
}

export const DEFAULT_PROVISION_POLLING_CONFIG: Readonly<ProvisionPollingConfig> = {
	pollIntervalMs: 2_000,
	timeoutMs: 120_000,
};

export interface CloudPlatformExecutionClientConfig {
	readonly baseUrl: string;
	readonly authProvider: CloudAuthProvider;
	/** Optional GitHub PAT for private-repo cloning inside the pod (PR #6 contract). */
	readonly githubToken?: string;
	/**
	 * Optional override for the `apiKey` forwarded to the provisioned pod as
	 * `CLINE_API_KEY`. When unset, the bearer token used to authenticate to
	 * core-api is forwarded (default). Supplying this lets the caller split
	 * the control-plane credential (e.g. a local-dev sk_ token accepted by a
	 * local core-api) from the credential cline inside the pod will use to
	 * call the inference gateway (which must be accepted by the gateway's
	 * auth domain). Useful for development against a local core-api while
	 * pods run on production cloud-platform.
	 */
	readonly podApiKey?: string;
	readonly retryConfigs?: Partial<
		Record<keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS, Partial<ExecutionClientRetryConfig>>
	>;
	readonly provisionPollingConfig?: Partial<ProvisionPollingConfig>;
	readonly fetch?: typeof globalThis.fetch;
	readonly delay?: (ms: number) => Promise<void>;
}

export interface RuntimeInfo {
	readonly transport: string;
	readonly connectUrl: string;
}

export interface CloudPlatformExecutionClient {
	createExecution(request: ExecutionCreateRequest, signal?: AbortSignal): Promise<ExecutionCreateResponse>;
	getExecutionStatus(executionId: string, signal?: AbortSignal): Promise<ExecutionStatusResponse>;
	cancelExecution(executionId: string, signal?: AbortSignal): Promise<void>;
	/**
	 * Returns the ACP runtime connection info for a provisioned instance, so
	 * the caller (runtime client) can open a WebSocket without re-querying
	 * core-api. Returns null if not yet known; call getExecutionStatus first.
	 * Optional so test stubs don't have to implement it.
	 */
	getInstanceRuntime?(executionId: string): RuntimeInfo | null;
}

function isRetryableStatus(statusCode: number): boolean {
	if (statusCode === 408 || statusCode === 429) return true;
	if (statusCode >= 400 && statusCode < 500) return false;
	if (statusCode >= 500) return true;
	return false;
}

interface CoreInstanceStatus {
	instanceId: string;
	state: string;
	hostname: string;
	namespace: string;
	runtime?: { transport: string; connectUrl: string } | null;
}

export class CloudPlatformExecutionHttpClient implements CloudPlatformExecutionClient {
	private readonly baseUrl: string;
	private readonly authProvider: CloudAuthProvider;
	private readonly githubToken: string;
	private readonly podApiKeyOverride: string;
	private readonly retryConfigs: Record<
		keyof typeof DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS,
		ExecutionClientRetryConfig
	>;
	private readonly provisionPolling: ProvisionPollingConfig;
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly delayFn: (ms: number) => Promise<void>;
	private readonly runtimeCache = new Map<string, RuntimeInfo>();
	private readonly executionMeta = new Map<string, { taskId: string; attemptNumber: number }>();

	constructor(config: CloudPlatformExecutionClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/+$/, "");
		this.authProvider = config.authProvider;
		this.githubToken = config.githubToken ?? "";
		this.podApiKeyOverride = config.podApiKey ?? "";
		this.fetchFn = config.fetch ?? globalThis.fetch;
		this.delayFn = config.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		this.retryConfigs = {
			createExecution: {
				...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.createExecution,
				...config.retryConfigs?.createExecution,
			},
			getStatus: { ...DEFAULT_EXECUTION_CLIENT_RETRY_CONFIGS.getStatus, ...config.retryConfigs?.getStatus },
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
		const apiKey = this.podApiKeyOverride || extractBearerToken(authHeaders);

		const requestedRuntime: Record<string, string> = { transport: "websocket" };
		if (validated.requestedRuntime?.transport) {
			requestedRuntime.transport = validated.requestedRuntime.transport;
		}
		if (validated.requestedRuntime?.providerId) {
			requestedRuntime.providerId = validated.requestedRuntime.providerId;
		}
		if (validated.requestedRuntime?.modelId) {
			requestedRuntime.modelId = validated.requestedRuntime.modelId;
		}

		const provisionBody: Record<string, unknown> = {
			repoUrl: validated.repoUrl,
			apiKey,
			instanceType: "acp",
			requestedRuntime,
		};
		if (this.githubToken) provisionBody.githubToken = this.githubToken;

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
		if (ready.runtime?.connectUrl) {
			this.runtimeCache.set(instanceId, {
				transport: ready.runtime.transport,
				connectUrl: ready.runtime.connectUrl,
			});
		}
		this.executionMeta.set(instanceId, {
			taskId: validated.taskId,
			attemptNumber: validated.attemptNumber,
		});

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
		const response = await this.executeWithRetry(
			async (sig) =>
				this.fetchFn(
					`${this.baseUrl}/api/v2/cloud-platform/instances/${encodeURIComponent(executionId)}`,
					{
						method: "GET",
						headers: { ...authHeaders, "X-Service-Name": "kanban" },
						signal: sig,
					},
				),
			this.retryConfigs.getStatus,
			signal,
		);
		if (response.status === 404) {
			return this.buildStatusResponse(executionId, "canceled", null, null);
		}
		const data = this.unwrapResponse(await response.json()) as CoreInstanceStatus;
		if (data?.runtime?.connectUrl) {
			this.runtimeCache.set(executionId, {
				transport: data.runtime.transport,
				connectUrl: data.runtime.connectUrl,
			});
		}
		return this.mapInstanceStatus(executionId, data);
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
		this.runtimeCache.delete(executionId);
		this.executionMeta.delete(executionId);
	}

	getInstanceRuntime(executionId: string): RuntimeInfo | null {
		return this.runtimeCache.get(executionId) ?? null;
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
				if (data.state === "ready" && data.hostname) return data;
				if (data.state === "failed") {
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
			message: `instance ${instanceId} did not reach ready in ${this.provisionPolling.timeoutMs}ms (last state: ${last?.state ?? "unknown"})`,
			statusCode: 504,
			retryable: false,
		});
	}

	private mapInstanceStatus(executionId: string, data: CoreInstanceStatus): ExecutionStatusResponse {
		let status: ExecutionStatusResponse["status"] = "queued";
		if (data.state === "provisioning" || data.state === "starting") status = "queued";
		else if (data.state === "ready") status = "running";
		else if (data.state === "failed" || data.state === "unhealthy") status = "failed";

		const error =
			status === "failed"
				? { code: "INSTANCE_FAILED", message: `Instance ${executionId} entered state ${data.state}` }
				: null;

		return this.buildStatusResponse(executionId, status, null, error);
	}

	private buildStatusResponse(
		executionId: string,
		status: ExecutionStatusResponse["status"],
		result: ExecutionStatusResponse["result"],
		error: ExecutionStatusResponse["error"],
	): ExecutionStatusResponse {
		const meta = this.executionMeta.get(executionId);
		return {
			executionId,
			status,
			taskId: meta?.taskId ?? executionId,
			attemptNumber: meta?.attemptNumber ?? 1,
			requestedByUserId: "",
			orgId: "",
			projectId: "",
			startedAt: null,
			finishedAt: null,
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
				if (response.ok || response.status === 204 || response.status === 404) return response;
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

function extractBearerToken(headers: Record<string, string>): string {
	const authz = headers["Authorization"] ?? headers["authorization"] ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(authz);
	return match?.[1] ?? "";
}

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
