// Integration test for the orchestrator ↔ CloudTaskChatService wiring
// introduced in Slice 3 (feat: wire CloudTaskChatService through
// orchestrator, bootstrap, state hub, and tRPC).
//
// These tests verify three behaviors that the unit tests for the chat
// service alone can't cover:
//
//   1. When the ACP WebSocket connects, the orchestrator relays the
//      original submit prompt to the pod as the first user_prompt
//      (via the chat service, which records the user message in the
//      transcript AND forwards it onto the WS).
//   2. When the WS receives inbound RuntimeMessages, the orchestrator
//      fans them through chatService.ingestInboundEvent so the transcript
//      stays in sync and subscribers see them via onMessage.
//   3. orchestrator.sendMessageToTask correctly returns { ok: false }
//      when the WS is not connected, and forwards the message via
//      wsHandle.send when it is.

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
import type {
	CloudRuntimeClient,
	RuntimeConnectionCallbacks,
	RuntimeConnectionState,
	RuntimeConnectRequest,
	RuntimeConnectResponse,
	RuntimeMessage,
	RuntimeWebSocketHandle,
} from "../../../src/cloud/cloud-runtime-client";
import { CloudTaskChatService } from "../../../src/cloud/cloud-task-chat-service";

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

interface MockStore extends CloudExecutionStoreInterface {
	pushExecution(execution: PersistedTaskExecution): void;
}

function createMockStore(): MockStore {
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
		pushExecution(execution) {
			executions.push({ ...execution });
		},
	};
}

function createMockExecutionClient(): CloudPlatformExecutionClient {
	return {
		async createExecution(req: ExecutionCreateRequest): Promise<ExecutionCreateResponse> {
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
				taskId: "task-1",
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
}

// Captures everything the orchestrator does through the runtime client so
// individual tests can assert against the control flow.
type MockHandle = RuntimeWebSocketHandle & {
	sent: RuntimeMessage[];
	deliverInbound: (msg: RuntimeMessage) => void;
	transitionTo: (state: RuntimeConnectionState) => void;
};

interface MockRuntimeWiring {
	client: CloudRuntimeClient;
	handle: MockHandle;
	connectRequests: RuntimeConnectRequest[];
}

function createMockRuntimeClient(): MockRuntimeWiring {
	const connectRequests: RuntimeConnectRequest[] = [];
	let capturedCallbacks: RuntimeConnectionCallbacks | null = null;
	const sent: RuntimeMessage[] = [];
	let connectionState: RuntimeConnectionState = "connecting";

	const handle: MockHandle = {
		sent,
		get state() {
			return connectionState;
		},
		send(msg: RuntimeMessage) {
			sent.push(msg);
		},
		close() {
			connectionState = "disconnected";
			capturedCallbacks?.onStateChange?.("disconnected");
		},
		deliverInbound(msg: RuntimeMessage) {
			capturedCallbacks?.onMessage?.(msg);
		},
		transitionTo(state: RuntimeConnectionState) {
			connectionState = state;
			capturedCallbacks?.onStateChange?.(state);
		},
	};

	const client: CloudRuntimeClient = {
		async connect(request: RuntimeConnectRequest): Promise<RuntimeConnectResponse> {
			connectRequests.push(request);
			return {
				instanceId: request.instanceId,
				connectUrl: `wss://gateway.test/instances/${request.instanceId}/ws`,
				assertion: "sk_mock_token",
				transport: "websocket",
				expiresInSeconds: 3_600,
			};
		},
		openWebSocket(_connectUrl, _assertion, callbacks): RuntimeWebSocketHandle {
			capturedCallbacks = callbacks;
			return handle;
		},
	};

	return { client, handle, connectRequests };
}

async function seedTaskToRunning(
	store: MockStore,
	taskId: string,
	submitMetadata: Record<string, unknown>,
): Promise<void> {
	const transitions: Array<[CloudExecutionState, CloudExecutionTrigger, CloudExecutionState, Record<string, unknown>?]> = [
		["draft", "submit", "queued", submitMetadata],
		["queued", "dequeue", "policy_check"],
		["policy_check", "authorized", "provisioning"],
		["provisioning", "sandbox_ready", "running", { cloudExecutionId: `exec-${taskId}` }],
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
	store.pushExecution({
		executionId: `exec-${taskId}`,
		taskId,
		attemptNumber: 1,
		instanceId: `exec-${taskId}`,
		branchIntent: "fresh_branch",
		worktreeIntent: `${taskId}/attempt-1`,
		startedAt: new Date().toISOString(),
		remoteMetadata: {
			instanceId: `exec-${taskId}`,
			repoUrl: (submitMetadata.repoUrl as string) ?? "",
			baseBranch: (submitMetadata.baseRef as string) ?? "main",
		},
	} as PersistedTaskExecution);
}

describe("CloudExecutionOrchestrator × CloudTaskChatService wiring", () => {
	it("relays the submit prompt as the first user_prompt when the ACP WS connects", async () => {
		const store = createMockStore();
		const executionClient = createMockExecutionClient();
		const runtime = createMockRuntimeClient();

		// Pre-declare to resolve the chatService → orchestrator forward-ref.
		// The test wires them in the same order the bootstrap does: construct
		// the chat service with a closure that captures a later-assigned
		// orchestrator, then construct the orchestrator with that chat
		// service. TypeScript needs the explicit type annotation because
		// both refer to each other.
		let orchestrator!: CloudExecutionOrchestrator;
		const chatService = new CloudTaskChatService({
			sendToTask: (taskId, message) => orchestrator.sendMessageToTask(taskId, message),
		});

		orchestrator = new CloudExecutionOrchestrator(
			store,
			executionClient,
			FAST_CONFIG,
			undefined,
			null,
			runtime.client,
			null,
			chatService,
		);

		const taskId = "task-relay-initial-prompt";
		await seedTaskToRunning(store, taskId, { prompt: "Fix the failing test", baseRef: "main" });

		// First tick: orchestrator calls runtime.connect, opens the WS, and
		// hands us the handle. ctx.wsConnected is set true synchronously, but
		// pendingInitialPrompt is relayed only via the onStateChange →
		// "connected" callback path.
		await orchestrator.processTask(taskId);
		expect(runtime.connectRequests).toHaveLength(1);

		// Simulate the gateway finishing its connect handshake. The
		// orchestrator's onStateChange("connected") branch is what triggers
		// the initial prompt relay — it fires chatService.sendUserPrompt,
		// which in turn records a user message AND calls back into
		// orchestrator.sendMessageToTask → wsHandle.send.
		runtime.handle.transitionTo("connected");

		// Transcript has the user prompt recorded (role="user", content=prompt text).
		const transcript = chatService.listMessages(taskId);
		const userMessages = transcript.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0]!.content).toBe("Fix the failing test");

		// And the prompt was actually sent on the WS exactly once:
		const userPrompts = runtime.handle.sent.filter((m) => m.type === "user_prompt");
		expect(userPrompts).toHaveLength(1);
		expect((userPrompts[0]!.payload as { text: string }).text).toBe("Fix the failing test");
	});

	it("fans inbound RuntimeMessages from the WS into the chat service transcript", async () => {
		const store = createMockStore();
		const executionClient = createMockExecutionClient();
		const runtime = createMockRuntimeClient();

		let orchestrator!: CloudExecutionOrchestrator;
		const chatService = new CloudTaskChatService({
			sendToTask: (taskId, message) => orchestrator.sendMessageToTask(taskId, message),
		});
		orchestrator = new CloudExecutionOrchestrator(
			store,
			executionClient,
			FAST_CONFIG,
			undefined,
			null,
			runtime.client,
			null,
			chatService,
		);

		const taskId = "task-fan-inbound";
		await seedTaskToRunning(store, taskId, { prompt: "hi", baseRef: "main" });

		await orchestrator.processTask(taskId);
		runtime.handle.transitionTo("connected");

		const beforeInbound = chatService.listMessages(taskId).length;

		// Simulate the pod sending an assistant text chunk. The chat service
		// coalesces agent_message_chunks into a single streaming assistant
		// message (role="assistant") and appends it to the transcript.
		runtime.handle.deliverInbound({
			type: "agent_message_chunk",
			payload: { text: "Looking at the failing test now…" },
		});

		const afterInbound = chatService.listMessages(taskId);
		expect(afterInbound.length).toBeGreaterThan(beforeInbound);
		const lastMessage = afterInbound[afterInbound.length - 1]!;
		expect(lastMessage.role).toBe("assistant");
		expect(lastMessage.content).toContain("Looking at the failing test");
	});

	it("sendMessageToTask returns ok:false when no cloud session is active", () => {
		const store = createMockStore();
		const executionClient = createMockExecutionClient();
		const orchestrator = new CloudExecutionOrchestrator(store, executionClient, FAST_CONFIG);

		const result = orchestrator.sendMessageToTask("no-such-task", {
			type: "user_prompt",
			payload: { text: "hello" },
		});
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/no active cloud session/i);
	});

	it("sendMessageToTask forwards the message through the WS handle when connected", async () => {
		const store = createMockStore();
		const executionClient = createMockExecutionClient();
		const runtime = createMockRuntimeClient();

		let orchestrator!: CloudExecutionOrchestrator;
		const chatService = new CloudTaskChatService({
			sendToTask: (taskId, message) => orchestrator.sendMessageToTask(taskId, message),
		});
		orchestrator = new CloudExecutionOrchestrator(
			store,
			executionClient,
			FAST_CONFIG,
			undefined,
			null,
			runtime.client,
			null,
			chatService,
		);

		const taskId = "task-send-after-connect";
		await seedTaskToRunning(store, taskId, { prompt: "first", baseRef: "main" });
		await orchestrator.processTask(taskId);
		runtime.handle.transitionTo("connected");

		// Drop the initial prompt relay so we're only asserting on the
		// explicit send that follows.
		runtime.handle.sent.length = 0;

		const result = orchestrator.sendMessageToTask(taskId, {
			type: "user_prompt",
			payload: { text: "follow-up question" },
		});
		expect(result.ok).toBe(true);
		expect(runtime.handle.sent).toHaveLength(1);
		expect(runtime.handle.sent[0]!.type).toBe("user_prompt");
		expect((runtime.handle.sent[0]!.payload as { text: string }).text).toBe(
			"follow-up question",
		);
	});
});
