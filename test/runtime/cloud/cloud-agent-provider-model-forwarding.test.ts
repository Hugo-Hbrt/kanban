// Regression test for cloud-platform PR #7 ↔ kanban contract:
//
//   The user's per-task agent/model choice (clineSettings.{providerId, modelId})
//   must survive the trip:
//
//     BoardCard.clineSettings
//       → UI mutate: runtime.startTaskSession({ clineSettings })
//       → server trpc runtime-api.ts: submit event metadata.{providerId, modelId}
//       → orchestrator: buildExecutionCreateRequest({ providerId, modelId })
//       → ExecutionCreateRequest.requestedRuntime.{providerId, modelId}
//       → HTTP POST to core-api
//       → core-api forwards to cloud-platform POST /instances as
//         requested_runtime.{provider_id, model_id}
//       → cloud-platform base64-encodes into pod Secret (CLINE_PROVIDER_ID,
//         CLINE_MODEL_ID) per PR #7
//       → entrypoint.sh passes them to `cline auth -p <provider> -m <model>`
//
// This test locks down the kanban-side of the chain: the submit-event-level
// metadata must flow into the ExecutionCreateRequest the orchestrator emits.
// If anyone ever drops `providerId` / `modelId` from the lifecycle
// metadata plumbing, PR #7's per-task model selection feature silently
// regresses to the pod's hardcoded defaults (cline / claude-sonnet-4.6), and
// this test will fail loudly.

import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import type {
	CloudExecutionState,
	CloudExecutionTrigger,
} from "../../../src/cloud/cloud-execution-lifecycle";
import type {
	CloudExecutionStoreInterface,
	OrchestratorConfig,
} from "../../../src/cloud/cloud-execution-orchestrator";
import { CloudExecutionOrchestrator } from "../../../src/cloud/cloud-execution-orchestrator";
import type {
	PersistedTaskEvent,
	PersistedTaskExecution,
} from "../../../src/cloud/cloud-execution-persistence";
import type { CloudPlatformExecutionClient } from "../../../src/cloud/cloud-platform-execution-client";
import type {
	ExecutionCreateRequest,
	ExecutionCreateResponse,
	ExecutionStatusResponse,
} from "../../../src/cloud/cloud-execution-contracts";

const FAST_CONFIG: OrchestratorConfig = {
	tickIntervalMs: 10,
	pollingConfig: {
		pollIntervalMs: 10,
		maxPollDurationMs: 60_000,
		maxConsecutiveErrors: 3,
	},
	orgId: "test-org",
	userId: "test-user",
	projectId: "test-project",
};

function createMockStore(): CloudExecutionStoreInterface & {
	push(execution: PersistedTaskExecution): void;
} {
	const events: PersistedTaskEvent[] = [];
	const executions: PersistedTaskExecution[] = [];
	return {
		async readEvents() {
			return [...events];
		},
		async readEventsForTask(taskId) {
			return events.filter((e) => e.taskId === taskId);
		},
		async deriveTaskState(taskId) {
			const taskEvents = events.filter((e) => e.taskId === taskId);
			if (taskEvents.length === 0) return "draft" as CloudExecutionState;
			return taskEvents[taskEvents.length - 1]!.toState;
		},
		async appendEvent(event) {
			events.push({ ...event });
		},
		async readExecutionsForTask(taskId) {
			return executions.filter((e) => e.taskId === taskId);
		},
		async updateExecution() {
			return true;
		},
		push(execution) {
			executions.push({ ...execution });
		},
	};
}

function createCapturingExecutionClient(): {
	client: CloudPlatformExecutionClient;
	captured: ExecutionCreateRequest[];
} {
	const captured: ExecutionCreateRequest[] = [];
	const client: CloudPlatformExecutionClient = {
		async createExecution(req): Promise<ExecutionCreateResponse> {
			captured.push(req);
			return {
				executionId: `exec-${req.taskId}`,
				status: "queued",
				taskId: req.taskId,
				attemptNumber: req.attemptNumber,
				createdAt: new Date().toISOString(),
			};
		},
		async getExecutionStatus(executionId): Promise<ExecutionStatusResponse> {
			return {
				executionId,
				status: "running",
				taskId: "task-provider-model-1",
				attemptNumber: 1,
				requestedByUserId: "test-user",
				orgId: "test-org",
				projectId: "test-project",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				result: null,
				error: null,
			};
		},
		async cancelExecution() {
			// no-op
		},
	};
	return { client, captured };
}

// Drive the orchestrator through the early lifecycle states that precede
// provisioning, seeding each transition via appendEvent so the orchestrator
// reads the providerId/modelId metadata from the submit event when it
// finally calls createExecution.
async function seedUpToProvisioning(
	store: CloudExecutionStoreInterface,
	taskId: string,
	submitMetadata: Record<string, unknown>,
): Promise<void> {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState, Record<string, unknown>?]> = [
		["draft", "submit", "queued", submitMetadata],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
	];
	for (const [from, trigger, to, metadata] of transitions) {
		await store.appendEvent({
			eventId: randomUUID(),
			taskId,
			trigger,
			fromState: from,
			toState: to,
			timestamp: new Date().toISOString(),
			triggerSource: trigger === "submit" ? "user" : "system",
			...(metadata ? { metadata } : {}),
		});
	}
}

describe("cloud-platform PR #7 alignment: per-task provider/model forwarding", () => {
	it("submit-event providerId/modelId surface on ExecutionCreateRequest.requestedRuntime", async () => {
		const store = createMockStore();
		const { client, captured } = createCapturingExecutionClient();

		const orchestrator = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		const taskId = "task-provider-model-1";
		await seedUpToProvisioning(store, taskId, {
			prompt: "Write tests for the new feature",
			baseRef: "main",
			executionMode: "cloud_agent",
			repoUrl: "git@github.com:acme/widgets.git",
			providerId: "openai",
			modelId: "gpt-4o",
		});

		await orchestrator.processTask(taskId);

		expect(captured).toHaveLength(1);
		const req = captured[0]!;
		expect(req.taskId).toBe(taskId);
		expect(req.requestedRuntime).toBeDefined();
		expect(req.requestedRuntime?.providerId).toBe("openai");
		expect(req.requestedRuntime?.modelId).toBe("gpt-4o");
	});

	it("omits requestedRuntime entirely when clineSettings were not set on the task", async () => {
		const store = createMockStore();
		const { client, captured } = createCapturingExecutionClient();

		const orchestrator = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		const taskId = "task-no-overrides";
		await seedUpToProvisioning(store, taskId, {
			prompt: "Just run it",
			baseRef: "main",
			executionMode: "cloud_agent",
			repoUrl: "git@github.com:acme/widgets.git",
			// no providerId, no modelId
		});

		await orchestrator.processTask(taskId);

		expect(captured).toHaveLength(1);
		// When neither provider nor model is set, buildExecutionCreateRequest
		// skips requestedRuntime so the pod falls back to entrypoint.sh's
		// defaults (cline / claude-sonnet-4.6). PR #7 confirms this path is
		// byte-identical to main.
		expect(captured[0]!.requestedRuntime).toBeUndefined();
	});

	it("partial overrides (providerId only) still reach the wire", async () => {
		const store = createMockStore();
		const { client, captured } = createCapturingExecutionClient();

		const orchestrator = new CloudExecutionOrchestrator(store, client, FAST_CONFIG);

		const taskId = "task-provider-only";
		await seedUpToProvisioning(store, taskId, {
			prompt: "use anthropic",
			baseRef: "main",
			executionMode: "cloud_agent",
			repoUrl: "git@github.com:acme/widgets.git",
			providerId: "anthropic",
			// modelId intentionally absent — pod will default the model
		});

		await orchestrator.processTask(taskId);

		expect(captured).toHaveLength(1);
		expect(captured[0]!.requestedRuntime?.providerId).toBe("anthropic");
		expect(captured[0]!.requestedRuntime?.modelId).toBeUndefined();
	});
});
