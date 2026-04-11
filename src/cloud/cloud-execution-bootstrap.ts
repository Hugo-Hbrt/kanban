// ---------------------------------------------------------------------------
// Cloud Execution Bootstrap — Production Wiring
// @phase MVP
// @prd-section 6, 12, 15.6
// ---------------------------------------------------------------------------
//
// Factory that assembles the complete cloud execution runtime from environment
// configuration. This is the single entry-point that the Kanban server calls
// to activate the cloud-agent execution path.
//
// Usage:
//   const cloud = bootstrapCloudExecution(process.env);
//   if (cloud) {
//     cloud.orchestrator.start();
//     // Use cloud.governanceClient, cloud.instanceClient, etc.
//   }
// ---------------------------------------------------------------------------

import { CloudExecutionStore } from "./cloud-execution-persistence";
import {
	CloudExecutionOrchestrator,
	type CloudInstanceFullClient,
	type CloudRunInvoker,
	type InvokeRunRequest,
	type InvokeRunResponse,
	type OrchestratorConfig,
	type OrchestratorLogger,
	DEFAULT_ORCHESTRATOR_CONFIG,
} from "./cloud-execution-orchestrator";
import {
	GovernanceHttpClient,
	type GovernanceClient,
	parseGovernanceConfig,
} from "./cloud-governance-client";
import {
	CloudInstanceHttpClient,
	type CloudInstanceClientConfig,
} from "./cloud-instance-client";
import type { CreateInstanceRequest } from "./cloud-execution-orchestrator";

// ---------------------------------------------------------------------------
// Instance Client Adapter
// ---------------------------------------------------------------------------

/**
 * Adapts CloudInstanceHttpClient (snake_case cloud-platform API) to the
 * orchestrator's CloudInstanceFullClient interface (camelCase).
 */
function createInstanceClientAdapter(
	config: CloudInstanceClientConfig,
): CloudInstanceFullClient {
	const httpClient = new CloudInstanceHttpClient(config);

	return {
		async createInstance(request: CreateInstanceRequest, signal?: AbortSignal) {
			const idempotencyKey = `create-${request.taskId}-${Date.now()}`;
			const result = await httpClient.createInstance(
				{
					user_id: config.serviceCredential,
					repo_url: request.repoUrl,
					api_key: config.serviceCredential,
					instance_type: "task-runner",
					pr_base_branch: request.baseBranch,
				},
				{
					taskId: request.taskId,
					idempotencyKey,
					executionIntent: {
						execution_mode: "cloud_agent",
						repo_url: request.repoUrl,
						base_branch: request.baseBranch,
						feature_branch_intent: request.featureBranch ?? "",
						worktree_intent: "",
						attempt_number: 1,
					},
				},
			);
			return {
				instance_id: result.response.instance_id,
				user_id: result.response.user_id,
				namespace: result.response.namespace,
				state: "provisioning" as const,
				hostname: result.response.hostname,
			};
		},
		async getInstance(instanceId: string, signal?: AbortSignal) {
			return httpClient.getInstance(instanceId, signal);
		},
		async deleteInstance(instanceId: string) {
			return httpClient.deleteInstance(instanceId);
		},
	};
}

// ---------------------------------------------------------------------------
// Environment Variable Names
// ---------------------------------------------------------------------------

const ENV = {
	CLOUD_PLATFORM_BASE_URL: "KANBAN_CLOUD_PLATFORM_BASE_URL",
	CLOUD_PLATFORM_API_KEY: "KANBAN_CLOUD_PLATFORM_API_KEY",
	CLOUD_EXECUTION_STORE_PATH: "KANBAN_CLOUD_EXECUTION_STORE_PATH",
	CLOUD_CALLBACK_URL: "KANBAN_CLOUD_CALLBACK_URL",
	CLOUD_CALLBACK_SECRET: "KANBAN_CLOUD_CALLBACK_SECRET",
	ORG_ID: "KANBAN_ORG_ID",
	USER_ID: "KANBAN_USER_ID",
	PROJECT_ID: "KANBAN_PROJECT_ID",
} as const;

// ---------------------------------------------------------------------------
// Bootstrap Result
// ---------------------------------------------------------------------------

export interface CloudExecutionRuntime {
	readonly orchestrator: CloudExecutionOrchestrator;
	readonly store: CloudExecutionStore;
	readonly instanceClient: CloudInstanceFullClient;
	readonly governanceClient: GovernanceClient | null;
	readonly runInvoker: CloudRunInvoker;
}

// ---------------------------------------------------------------------------
// HTTP Run Invoker — calls POST /run on the task-runner instance
// ---------------------------------------------------------------------------

class HttpRunInvoker implements CloudRunInvoker {
	private readonly callbackUrl: string;
	private readonly callbackSecret: string;
	private readonly fetchFn: typeof globalThis.fetch;

	constructor(callbackUrl: string, callbackSecret: string, fetchFn?: typeof globalThis.fetch) {
		this.callbackUrl = callbackUrl;
		this.callbackSecret = callbackSecret;
		this.fetchFn = fetchFn ?? globalThis.fetch;
	}

	async composePrompt(taskId: string): Promise<string> {
		// In production, this reads the task's prompt from persistence.
		// For now, return a placeholder that the orchestrator can override.
		return `Execute task ${taskId}`;
	}

	async invokeRun(request: InvokeRunRequest, signal?: AbortSignal): Promise<InvokeRunResponse> {
		const url = `https://${request.hostname}/run`;
		const body = {
			prompt: request.prompt,
			callback_url: request.callbackUrl ?? this.callbackUrl,
			task_id: request.taskId,
			attempt_number: request.attemptNumber ?? 1,
			branch_name: request.branchName,
		};

		const response = await this.fetchFn(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		});

		if (response.status === 202) {
			return { accepted: true };
		}

		return { accepted: false };
	}
}

// ---------------------------------------------------------------------------
// Bootstrap Function
// ---------------------------------------------------------------------------

/**
 * Bootstrap the cloud execution runtime from environment variables.
 *
 * Returns `null` if cloud execution is not configured (missing base URL).
 * This allows the Kanban server to start in local-only mode when cloud
 * infrastructure is not available.
 */
export function bootstrapCloudExecution(
	env: Record<string, string | undefined>,
	logger: OrchestratorLogger = { info: () => {}, warn: () => {}, error: () => {} },
	overrides?: {
		instanceClient?: CloudInstanceFullClient;
		runInvoker?: CloudRunInvoker;
		orchestratorConfig?: Partial<OrchestratorConfig>;
		fetchFn?: typeof globalThis.fetch;
	},
): CloudExecutionRuntime | null {
	const cloudBaseUrl = env[ENV.CLOUD_PLATFORM_BASE_URL];
	if (!cloudBaseUrl) {
		logger.info("Cloud execution not configured: KANBAN_CLOUD_PLATFORM_BASE_URL not set");
		return null;
	}

	const apiKey = env[ENV.CLOUD_PLATFORM_API_KEY] ?? "";
	const storePath = env[ENV.CLOUD_EXECUTION_STORE_PATH] ?? "./data/cloud-executions";
	const callbackUrl = env[ENV.CLOUD_CALLBACK_URL] ?? "";
	const callbackSecret = env[ENV.CLOUD_CALLBACK_SECRET] ?? "";

	// Persistence
	const store = new CloudExecutionStore(storePath);

	// Cloud-platform instance client — adapt HTTP client to orchestrator interface
	const instanceClient: CloudInstanceFullClient = overrides?.instanceClient ?? createInstanceClientAdapter({
		baseUrl: cloudBaseUrl,
		serviceCredential: apiKey,
		fetch: overrides?.fetchFn,
	});

	// Run invoker
	const runInvoker: CloudRunInvoker = overrides?.runInvoker ?? new HttpRunInvoker(
		callbackUrl,
		callbackSecret,
		overrides?.fetchFn,
	);

	// Governance client (optional — returns null if not configured)
	const govConfig = parseGovernanceConfig(env);
	const governanceClient: GovernanceClient | null = govConfig
		? new GovernanceHttpClient(govConfig, logger)
		: null;

	// Orchestrator config
	const config: OrchestratorConfig = {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orgId: env[ENV.ORG_ID],
		userId: env[ENV.USER_ID],
		projectId: env[ENV.PROJECT_ID],
		...overrides?.orchestratorConfig,
	};

	// Assemble orchestrator
	const orchestrator = new CloudExecutionOrchestrator(
		store,
		instanceClient,
		runInvoker,
		config,
		logger,
		null, // concurrency limiter — Phase 2
		governanceClient,
	);

	logger.info("Cloud execution runtime bootstrapped", {
		cloudBaseUrl,
		storePath,
		governanceEnabled: !!governanceClient,
		callbackUrl: callbackUrl ? "configured" : "not set",
	});

	return { orchestrator, store, instanceClient, governanceClient, runInvoker };
}
