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
// KB-AUTH-3: Rewritten to use CloudPlatformExecutionClient instead of
// direct runner invocation. Kanban now talks ONLY to cloud-platform.
// ---------------------------------------------------------------------------

import { CloudExecutionStore } from "./cloud-execution-persistence";
import {
	CloudExecutionOrchestrator,
	type OrchestratorConfig,
	type OrchestratorLogger,
	DEFAULT_ORCHESTRATOR_CONFIG,
} from "./cloud-execution-orchestrator";
import {
	GovernanceHttpClient,
	type GovernanceClient,
	parseGovernanceConfig,
} from "./cloud-governance-client";
import { EnvironmentCloudAuthProvider, type CloudAuthProvider } from "./cloud-auth-provider";
import {
	CloudPlatformExecutionHttpClient,
	type CloudPlatformExecutionClient,
} from "./cloud-platform-execution-client";

// ---------------------------------------------------------------------------
// Environment Variable Names
// ---------------------------------------------------------------------------

const ENV = {
	CLOUD_PLATFORM_BASE_URL: "KANBAN_CLOUD_PLATFORM_BASE_URL",
	CLOUD_PLATFORM_API_KEY: "KANBAN_CLOUD_PLATFORM_API_KEY",
	CLOUD_EXECUTION_STORE_PATH: "KANBAN_CLOUD_EXECUTION_STORE_PATH",
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
	readonly executionClient: CloudPlatformExecutionClient;
	readonly governanceClient: GovernanceClient | null;
	readonly authProvider: CloudAuthProvider;
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
		executionClient?: CloudPlatformExecutionClient;
		authProvider?: CloudAuthProvider;
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

	// Auth provider — reuses existing Cline credential (KB-AUTH-1)
	const authProvider: CloudAuthProvider = overrides?.authProvider ?? new EnvironmentCloudAuthProvider({ apiKey });

	// Persistence
	const store = new CloudExecutionStore(storePath);

	// Cloud-platform execution client (KB-AUTH-3)
	const executionClient: CloudPlatformExecutionClient = overrides?.executionClient ?? new CloudPlatformExecutionHttpClient({
		baseUrl: cloudBaseUrl,
		authProvider,
		fetch: overrides?.fetchFn,
	});

	// Governance client (optional — returns null if not configured)
	const govConfig = parseGovernanceConfig(env, { authProvider });
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
		executionClient,
		config,
		logger,
		null, // concurrency limiter — Phase 2
		governanceClient,
	);

	logger.info("Cloud execution runtime bootstrapped", {
		cloudBaseUrl,
		storePath,
		governanceEnabled: !!governanceClient,
	});

	return { orchestrator, store, executionClient, governanceClient, authProvider };
}
