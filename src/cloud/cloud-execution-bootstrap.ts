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
// Boundary realignment: Execution CRUD now routes through core-api (the public
// control plane), not directly to cloud-platform. KANBAN_CLOUD_PLATFORM_BASE_URL
// should point to core-api's base URL.
// ---------------------------------------------------------------------------

import { type CloudAuthProvider, EnvironmentCloudAuthProvider } from "./cloud-auth-provider";
import { CloudBackgroundPoller } from "./cloud-background-poller";
import { type CloudCapabilitiesClient, CloudCapabilitiesHttpClient } from "./cloud-capabilities-client";
import {
	CloudExecutionOrchestrator,
	DEFAULT_ORCHESTRATOR_CONFIG,
	type OrchestratorConfig,
	type OrchestratorLogger,
} from "./cloud-execution-orchestrator";
import { CloudExecutionStore } from "./cloud-execution-persistence";
import type { GovernanceClient } from "./cloud-governance-client";
import { type CloudPlatformExecutionClient, CloudPlatformExecutionHttpClient } from "./cloud-platform-execution-client";
import { type CloudRuntimeClient, DefaultCloudRuntimeClient } from "./cloud-runtime-client";

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
	GATEWAY_BASE_URL: "KANBAN_GATEWAY_BASE_URL",
	RUNTIME_PATH: "KANBAN_RUNTIME_PATH",
} as const;

/**
 * Runtime path preference:
 * - "target": Use gateway + WebSocket as the primary runtime path (recommended).
 *   Falls back to bridge (HTTP polling) if gateway is unavailable.
 * - "bridge": Use HTTP CRUD/polling only. No WebSocket connections.
 */
export type RuntimePathPreference = "target" | "bridge";

// ---------------------------------------------------------------------------
// Bootstrap Result
// ---------------------------------------------------------------------------

export interface CloudExecutionRuntime {
	readonly orchestrator: CloudExecutionOrchestrator;
	readonly store: CloudExecutionStore;
	readonly executionClient: CloudPlatformExecutionClient;
	readonly runtimeClient: CloudRuntimeClient | null;
	readonly governanceClient: GovernanceClient | null;
	readonly capabilitiesClient: CloudCapabilitiesClient;
	readonly authProvider: CloudAuthProvider;
	readonly runtimePath: RuntimePathPreference;
	readonly backgroundPoller: CloudBackgroundPoller;
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
		capabilitiesClient?: CloudCapabilitiesClient;
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
	const executionClient: CloudPlatformExecutionClient =
		overrides?.executionClient ??
		new CloudPlatformExecutionHttpClient({
			baseUrl: cloudBaseUrl,
			authProvider,
			fetch: overrides?.fetchFn,
		});

	// Capabilities client — powers the UI's cloud-agent gate via tRPC.
	// Same base URL as the execution client; same auth provider.
	const capabilitiesClient: CloudCapabilitiesClient =
		overrides?.capabilitiesClient ??
		new CloudCapabilitiesHttpClient({
			baseUrl: cloudBaseUrl,
			authProvider,
			fetch: overrides?.fetchFn,
		});

	// Runtime path preference — "target" uses gateway+WebSocket, "bridge" uses HTTP polling
	const runtimePath: RuntimePathPreference = (env[ENV.RUNTIME_PATH] as RuntimePathPreference) || "target";
	const gatewayBaseUrl = env[ENV.GATEWAY_BASE_URL] ?? "";

	// Cloud runtime client (target path — gateway + WebSocket)
	let runtimeClient: CloudRuntimeClient | null = null;
	if (runtimePath === "target" && gatewayBaseUrl) {
		runtimeClient = new DefaultCloudRuntimeClient({
			gatewayBaseUrl,
			authProvider,
		});
		logger.info("Target runtime path enabled: gateway + WebSocket", { gatewayBaseUrl });
	} else if (runtimePath === "target" && !gatewayBaseUrl) {
		logger.warn(
			"KANBAN_RUNTIME_PATH=target but KANBAN_GATEWAY_BASE_URL not set — falling back to bridge (HTTP polling)",
		);
	} else {
		logger.info("Bridge runtime path: HTTP CRUD/polling only");
	}

	// Governance client — no longer wired up. The core-api governance domain
	// was removed when the execution plane was simplified to direct
	// kanban→pod polling. The orchestrator's governance branches are
	// null-guarded and become no-ops.
	const governanceClient: GovernanceClient | null = null;

	// Orchestrator config
	const config: OrchestratorConfig = {
		...DEFAULT_ORCHESTRATOR_CONFIG,
		orgId: env[ENV.ORG_ID],
		userId: env[ENV.USER_ID],
		projectId: env[ENV.PROJECT_ID],
		...overrides?.orchestratorConfig,
	};

	// Assemble orchestrator — runtimeClient enables target path (gateway+WebSocket)
	const orchestrator = new CloudExecutionOrchestrator(
		store,
		executionClient,
		config,
		logger,
		null, // concurrency limiter — Phase 2
		governanceClient,
		runtimeClient,
	);

	// Background poller — drives processTask() for active cloud tasks
	const backgroundPoller = new CloudBackgroundPoller({
		orchestrator,
		logger,
		onTerminal: (taskId, terminalState) => {
			logger.info("[cloud-bootstrap] Task reached terminal state", { taskId, terminalState });
		},
	});

	logger.info("Cloud execution runtime bootstrapped", {
		cloudBaseUrl,
		storePath,
		runtimePath,
		gatewayEnabled: !!runtimeClient,
		governanceEnabled: !!governanceClient,
	});

	return {
		orchestrator,
		store,
		executionClient,
		runtimeClient,
		governanceClient,
		capabilitiesClient,
		authProvider,
		runtimePath,
		backgroundPoller,
	};
}
