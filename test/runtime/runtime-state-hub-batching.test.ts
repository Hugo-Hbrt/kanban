// Regression test for the cloud /ask → reply → Review→In_Progress flip bug.
//
// The hub batches task session summary broadcasts on a ~150ms window to avoid
// UI thrash. Prior to the fix, the batch coalesced by taskId alone and simply
// overwrote the pending entry — so a rapid sequence
// `awaiting_review/hook → running → awaiting_review/attention` (all within the
// window, which is common for mock agents and fast real runs) collapsed to
// just the final `awaiting_review/attention`. The UI never observed the
// intermediate `running` state, so the board auto-move logic
// (running + columnId=review → in_progress) never fired — the card stayed
// stuck in Review after a user reply.
//
// The fix: when a new summary has a different state or reviewReason than the
// currently-pending one for the same taskId, flush the batch first so every
// distinct state transition reaches the UI.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import type {
	RuntimeStateStreamMessage,
	RuntimeStateStreamTaskSessionsMessage,
	RuntimeTaskSessionSummary,
} from "../../src/core/api-contract";
import { createRuntimeStateHub } from "../../src/server/runtime-state-hub";
import type { TerminalSessionManager } from "../../src/terminal/session-manager";

type SummaryListener = (summary: RuntimeTaskSessionSummary) => void;

function makeSummary(taskId: string, patch: Partial<RuntimeTaskSessionSummary>): RuntimeTaskSessionSummary {
	const now = Date.now();
	return {
		taskId,
		state: "running",
		mode: null,
		agentId: null,
		workspacePath: null,
		pid: null,
		startedAt: now,
		updatedAt: now,
		lastOutputAt: null,
		reviewReason: null,
		exitCode: null,
		lastHookAt: null,
		latestHookActivity: null,
		...patch,
	};
}

function createFakeTerminalManager(): {
	manager: TerminalSessionManager;
	emit: (summary: RuntimeTaskSessionSummary) => void;
} {
	const listeners = new Set<SummaryListener>();
	const manager = {
		onSummary: (listener: SummaryListener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	} as unknown as TerminalSessionManager;
	return {
		manager,
		emit: (summary) => {
			for (const listener of listeners) listener(summary);
		},
	};
}

async function setupHubServer() {
	const workspaceId = "ws-test";
	const workspacePath = "/tmp/ws-test";
	const hub = createRuntimeStateHub({
		workspaceRegistry: {
			resolveWorkspaceForStream: async () => ({
				workspaceId,
				workspacePath,
				didPruneProjects: false,
				removedRequestedWorkspacePath: null,
			}),
			buildProjectsPayload: async () => ({
				currentProjectId: workspaceId,
				projects: [],
			}),
			buildWorkspaceStateSnapshot: async () => ({
				board: { columns: [], dependencies: [] },
				projectMetadata: null,
				currentBranch: null,
				repoRoot: null,
				headStatus: null,
			}),
		},
	});

	const server: Server = createServer();
	server.on("upgrade", (req, socket, head) => {
		hub.handleUpgrade(req, socket, head, { requestedWorkspaceId: workspaceId });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;

	const messages: RuntimeStateStreamMessage[] = [];
	const client = new WebSocket(`ws://127.0.0.1:${port}/`);
	const snapshotReady = new Promise<void>((resolve) => {
		client.on("message", (raw) => {
			const parsed = JSON.parse(String(raw)) as RuntimeStateStreamMessage;
			messages.push(parsed);
			if (parsed.type === "snapshot") resolve();
		});
	});
	await new Promise<void>((resolve, reject) => {
		client.once("open", () => resolve());
		client.once("error", reject);
	});
	await snapshotReady;

	return {
		hub,
		server,
		client,
		messages,
		workspaceId,
		async cleanup() {
			client.close();
			await hub.close();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

describe("runtime-state-hub task_sessions batching", () => {
	it("broadcasts every distinct state transition even when emitted within the batch window", async () => {
		const { hub, client, messages, workspaceId, cleanup } = await setupHubServer();
		const { manager, emit } = createFakeTerminalManager();
		hub.trackTerminalManager(workspaceId, manager);

		const taskId = "task-abc";
		// Mirrors the mock-cloud-platform sequence when user sends /ask then /done:
		// awaiting_review/hook → running → awaiting_review/attention, all within ~50ms
		emit(makeSummary(taskId, { state: "awaiting_review", reviewReason: "hook" }));
		emit(makeSummary(taskId, { state: "running", reviewReason: null }));
		emit(makeSummary(taskId, { state: "awaiting_review", reviewReason: "attention" }));

		// Wait past the 150ms batch window for the final flush
		await new Promise((resolve) => setTimeout(resolve, 250));

		const observedSessions = messages.filter(
			(m): m is RuntimeStateStreamTaskSessionsMessage => m.type === "task_sessions_updated",
		);
		const transitions = observedSessions
			.flatMap((m) => m.summaries.filter((s) => s.taskId === taskId))
			.map((s) => `${s.state}/${s.reviewReason ?? "-"}`);

		expect(transitions).toContain("awaiting_review/hook");
		expect(transitions).toContain("running/-");
		expect(transitions).toContain("awaiting_review/attention");

		const hookIdx = transitions.indexOf("awaiting_review/hook");
		const runningIdx = transitions.indexOf("running/-");
		const attentionIdx = transitions.indexOf("awaiting_review/attention");
		expect(hookIdx).toBeLessThan(runningIdx);
		expect(runningIdx).toBeLessThan(attentionIdx);

		await cleanup();
	});

	it("still coalesces identical-state updates (batching is not disabled)", async () => {
		const { hub, messages, workspaceId, cleanup } = await setupHubServer();
		const { manager, emit } = createFakeTerminalManager();
		hub.trackTerminalManager(workspaceId, manager);

		const taskId = "task-noise";
		// Three emits with the same state/reviewReason — just updatedAt churn.
		// Should all coalesce into a single broadcast (batching still works).
		emit(makeSummary(taskId, { state: "running", reviewReason: null, lastOutputAt: 1 }));
		emit(makeSummary(taskId, { state: "running", reviewReason: null, lastOutputAt: 2 }));
		emit(makeSummary(taskId, { state: "running", reviewReason: null, lastOutputAt: 3 }));

		await new Promise((resolve) => setTimeout(resolve, 250));

		const observedSessions = messages.filter(
			(m): m is RuntimeStateStreamTaskSessionsMessage => m.type === "task_sessions_updated",
		);
		const matchingBroadcasts = observedSessions.filter((m) =>
			m.summaries.some((s) => s.taskId === taskId),
		);
		expect(matchingBroadcasts).toHaveLength(1);
		expect(matchingBroadcasts[0]?.summaries[0]?.lastOutputAt).toBe(3);

		await cleanup();
	});
});
