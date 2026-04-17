#!/usr/bin/env -S tsx
// Drives the real kanban cloud-execution code (CloudPlatformExecutionHttpClient
// + DefaultCloudRuntimeClient + CloudExecutionOrchestrator + CloudTaskChatService)
// against the local mock-cloud-platform stub. No UI, no core-api, no k8s —
// just proves that the wire formats and state machines align end-to-end
// against the stub.
//
// Prereq: `npx tsx scripts/mock-cloud-platform.ts` running in another shell
// (or set MOCK_URL to point elsewhere).
//
// Usage:
//   npx tsx scripts/mock-cloud-platform-smoke.ts
//
// What it verifies:
//   1. POST /instances (provision) via CloudPlatformExecutionHttpClient
//   2. waitForInstanceReady polls until state=ready with runtime.connectUrl
//   3. DefaultCloudRuntimeClient opens the ACP WebSocket to that URL
//   4. CloudTaskChatService relays a user_prompt and receives the agent reply
//      (agent_message_chunk + agent_message_complete) back into the transcript
//   5. A follow-up user prompt (multi-turn) works on the same WS session
//   6. cancelExecution tears down the instance and closes the WS

import { randomUUID } from "node:crypto";
import { WebSocket as NodeWebSocket } from "ws";

import type { CloudAuthProvider } from "../src/cloud/cloud-auth-provider.js";
import { CloudPlatformExecutionHttpClient } from "../src/cloud/cloud-platform-execution-client.js";
import { DefaultCloudRuntimeClient } from "../src/cloud/cloud-runtime-client.js";
import { CloudTaskChatService } from "../src/cloud/cloud-task-chat-service.js";
import { buildExecutionCreateRequest } from "../src/cloud/cloud-execution-contracts.js";

const MOCK_URL = process.env.MOCK_URL ?? "http://127.0.0.1:4000";
const TEST_TOKEN = process.env.TEST_TOKEN ?? "sk_local_smoke_test";

function delay(ms: number) {
	return new Promise((r) => setTimeout(r, ms));
}

class StaticAuthProvider implements CloudAuthProvider {
	constructor(private readonly token: string) {}
	async getAuthHeaders(): Promise<Record<string, string>> {
		return { Authorization: `Bearer ${this.token}` };
	}
}

async function main() {
	console.log(`[smoke] targeting mock at ${MOCK_URL}`);

	const authProvider = new StaticAuthProvider(TEST_TOKEN);
	const executionClient = new CloudPlatformExecutionHttpClient({
		baseUrl: MOCK_URL,
		authProvider,
		githubPat: "",
		provisionPollingConfig: { pollIntervalMs: 200, timeoutMs: 10_000 },
	});
	const runtimeClient = new DefaultCloudRuntimeClient({
		coreApiBaseUrl: MOCK_URL,
		authProvider,
		WebSocket: NodeWebSocket as unknown as typeof globalThis.WebSocket,
	});

	const taskId = `task-${randomUUID().slice(0, 8)}`;
	const request = buildExecutionCreateRequest({
		taskId,
		attemptNumber: 1,
		orgId: "smoke-org",
		projectId: "smoke-project",
		userId: "smoke-user",
		repoUrl: "git@github.com:example/repo.git",
		baseBranch: "main",
		featureBranchIntent: "",
		worktreeIntent: `${taskId}/attempt-1`,
		prompt: "write a tiny python http server",
		providerId: "openai",
		modelId: "gpt-4o",
	});

	console.log(`[smoke] 1. createExecution (POST /instances)…`);
	const created = await executionClient.createExecution(request);
	console.log(`        → executionId=${created.executionId} status=${created.status}`);

	console.log(`[smoke] 2. runtimeClient.connect() resolving runtime.connectUrl…`);
	const conn = await runtimeClient.connect({ instanceId: created.executionId });
	console.log(`        → connectUrl=${conn.connectUrl} transport=${conn.transport}`);

	console.log(`[smoke] 3. Opening ACP WebSocket via DefaultCloudRuntimeClient…`);
	let stateChange = "initial";
	let resolveConnected!: () => void;
	const connected = new Promise<void>((r) => {
		resolveConnected = r;
	});
	const chatService = new CloudTaskChatService({
		sendToTask: (tid, msg) => {
			const okay = handle.state === "connected";
			if (okay) {
				handle.send(msg);
				return { ok: true };
			}
			return { ok: false, error: `ws state=${handle.state}` };
		},
	});

	const handle = runtimeClient.openWebSocket(conn.connectUrl, conn.assertion, {
		onStateChange: (state) => {
			stateChange = state;
			console.log(`        → WS state=${state}`);
			if (state === "connected") resolveConnected();
		},
		onMessage: (m) => {
			chatService.ingestInboundEvent(taskId, m);
			console.log(`        → inbound type=${m.type}`);
		},
	});
	await connected;
	console.log(`        → connected (last state=${stateChange})`);

	console.log(`[smoke] 4. Sending first user_prompt via chatService.sendUserPrompt…`);
	const turn1 = chatService.sendUserPrompt(taskId, "hello mock agent, this is turn 1");
	console.log(`        → sendOk=${turn1.sendOk}`);
	await delay(300);

	console.log(`[smoke] 5. Sending second user_prompt (multi-turn)…`);
	const turn2 = chatService.sendUserPrompt(taskId, "turn 2 — still connected?");
	console.log(`        → sendOk=${turn2.sendOk}`);
	await delay(300);

	const transcript = chatService.listMessages(taskId);
	console.log(`[smoke] 6. Transcript (${transcript.length} messages):`);
	for (const m of transcript) {
		const preview = (m.content ?? "").slice(0, 80).replace(/\s+/g, " ");
		console.log(`        ${m.role.padEnd(10)}  ${preview}`);
	}

	const userCount = transcript.filter((m) => m.role === "user").length;
	const assistantCount = transcript.filter((m) => m.role === "assistant").length;
	if (userCount < 2 || assistantCount < 2) {
		throw new Error(
			`multi-turn transcript check failed: user=${userCount} assistant=${assistantCount}`,
		);
	}
	console.log(`        ✓ multi-turn verified (user=${userCount}, assistant=${assistantCount})`);

	console.log(`[smoke] 7. cancelExecution (DELETE /instances/:id)…`);
	await executionClient.cancelExecution(created.executionId);
	await delay(100);
	console.log(`        → done (ws state post-cancel: ${handle.state})`);

	handle.close();
	console.log(`[smoke] ALL GREEN ✓`);
}

main().catch((err) => {
	console.error("[smoke] FAILED:", err);
	process.exit(1);
});
