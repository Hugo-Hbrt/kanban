#!/usr/bin/env -S tsx
// Lightweight in-process mock of core-api's cloud-platform surface, for
// local e2e testing of kanban's cloud_agent flow without spinning up
// core-api + cloud-platform + k8s.
//
// What it serves (matching the contract in src/cloud/cloud-platform-execution-client.ts,
// src/cloud/cloud-runtime-client.ts, and src/cloud/cloud-capabilities-client.ts):
//
//   GET    /api/v2/cloud-platform/capabilities     → { cloudAgentAllowed, reason }
//   POST   /api/v2/cloud-platform/instances        → create (provision)
//   GET    /api/v2/cloud-platform/instances/:id    → status (w/ runtime.connectUrl)
//   DELETE /api/v2/cloud-platform/instances/:id    → cancel/teardown
//   WS     /ws/:id?token=sk_...                    → ACP WebSocket (echo agent)
//
// Response envelope matches the { success, data } wrapper that
// unwrapResponse() in the execution client unwraps.
//
// The WS agent is minimal-but-useful: when it receives a RuntimeMessage
// of type "user_prompt", it responds with
//   - agent_message_chunk { text: "Mock agent received: <prompt>" }
//   - turn_completed {}
// so kanban's CloudTaskChatService fan-out and multi-turn transcript
// wiring can be exercised end-to-end. `turn_completed` is the terminal
// event kanban's chat service uses to finalize the streaming assistant
// message (see src/cloud/cloud-task-chat-service.ts); using
// `agent_message_complete` instead would surface as an "Unhandled cloud
// event" status message and cause successive turns to coalesce into one
// assistant message.
//
// Usage:
//   PORT=4000 npx tsx scripts/mock-cloud-platform.ts
//
// Then in another shell:
//   KANBAN_CLOUD_PLATFORM_BASE_URL=http://localhost:4000 \
//     KANBAN_CLOUD_PLATFORM_API_KEY=sk_local_test \
//     npm run dev
//
// Any sk_... token is accepted; auth is strictly for contract-shape
// coverage, not security.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "127.0.0.1";
const PROVISION_READY_DELAY_MS = Number(process.env.PROVISION_READY_DELAY_MS ?? 300);

type InstanceState = "provisioning" | "starting" | "ready" | "failed" | "terminated";

interface Instance {
	instanceId: string;
	state: InstanceState;
	hostname: string;
	namespace: string;
	createdAt: number;
	readyAt: number | null;
	repoUrl: string;
	requestedRuntime: {
		transport?: string;
		providerId?: string;
		modelId?: string;
	};
	apiKey: string | null;
}

const instances = new Map<string, Instance>();
const activeSockets = new Map<string, Set<WebSocket>>();

function send(res: ServerResponse, status: number, body: unknown): void {
	const json = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(json),
	});
	res.end(json);
}

function envelopeOk<T>(data: T) {
	return { success: true, data };
}

function envelopeErr(message: string) {
	return { success: false, error: message };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	if (chunks.length === 0) return {};
	const raw = Buffer.concat(chunks).toString("utf8");
	if (!raw.trim()) return {};
	try {
		return JSON.parse(raw);
	} catch {
		throw new Error("invalid JSON body");
	}
}

function instanceView(instance: Instance) {
	const isReady = instance.state === "ready";
	return {
		instanceId: instance.instanceId,
		state: instance.state,
		hostname: isReady ? instance.hostname : "",
		namespace: instance.namespace,
		runtime: isReady
			? {
					transport: "websocket",
					connectUrl: `ws://${HOST}:${PORT}/ws/${instance.instanceId}`,
				}
			: null,
	};
}

function handleCreateInstance(req: IncomingMessage, res: ServerResponse) {
	void (async () => {
		let body: Record<string, unknown> = {};
		try {
			body = (await readJson(req)) as Record<string, unknown>;
		} catch (err) {
			return send(res, 400, envelopeErr(err instanceof Error ? err.message : "bad request"));
		}
		const repoUrl = typeof body.repoUrl === "string" ? body.repoUrl : "";
		const apiKey = typeof body.apiKey === "string" ? body.apiKey : null;
		const requestedRuntime =
			typeof body.requestedRuntime === "object" && body.requestedRuntime !== null
				? (body.requestedRuntime as Instance["requestedRuntime"])
				: {};

		const instanceId = `ins-${randomUUID().slice(0, 8)}`;
		const instance: Instance = {
			instanceId,
			state: "provisioning",
			hostname: `${HOST}:${PORT}`,
			namespace: "mock",
			createdAt: Date.now(),
			readyAt: null,
			repoUrl,
			requestedRuntime,
			apiKey,
		};
		instances.set(instanceId, instance);

		setTimeout(() => {
			const current = instances.get(instanceId);
			if (!current) return;
			current.state = "ready";
			current.readyAt = Date.now();
			console.log(
				`[mock-cloud-platform] instance ${instanceId} -> ready (provider=${requestedRuntime.providerId ?? "<default>"}, model=${requestedRuntime.modelId ?? "<default>"})`,
			);
		}, PROVISION_READY_DELAY_MS);

		console.log(
			`[mock-cloud-platform] POST /instances -> ${instanceId} (repo=${repoUrl || "<none>"})`,
		);
		send(res, 201, envelopeOk(instanceView(instance)));
	})();
}

function handleGetInstance(res: ServerResponse, instanceId: string) {
	const instance = instances.get(instanceId);
	if (!instance) return send(res, 404, envelopeErr(`instance ${instanceId} not found`));
	send(res, 200, envelopeOk(instanceView(instance)));
}

function handleDeleteInstance(res: ServerResponse, instanceId: string) {
	const instance = instances.get(instanceId);
	if (!instance) return send(res, 404, envelopeErr(`instance ${instanceId} not found`));
	instance.state = "terminated";
	const sockets = activeSockets.get(instanceId);
	if (sockets) {
		for (const ws of sockets) {
			try {
				ws.close(1000, "instance terminated");
			} catch {
				// ignore
			}
		}
		activeSockets.delete(instanceId);
	}
	console.log(`[mock-cloud-platform] DELETE /instances/${instanceId} -> terminated`);
	send(res, 200, envelopeOk({ instanceId, state: "terminated" }));
}

const server = createServer((req, res) => {
	const url = req.url ?? "/";
	const method = req.method ?? "GET";

	if (method === "GET" && url === "/api/v2/cloud-platform/capabilities") {
		return send(
			res,
			200,
			envelopeOk({
				cloudAgentAllowed: true,
				reason: "mock-cloud-platform: always-allowed for local dev",
			}),
		);
	}

	if (method === "POST" && url === "/api/v2/cloud-platform/instances") {
		return handleCreateInstance(req, res);
	}

	const instanceMatch = url.match(/^\/api\/v2\/cloud-platform\/instances\/([^/?]+)/);
	if (instanceMatch) {
		const instanceId = decodeURIComponent(instanceMatch[1]!);
		if (method === "GET") return handleGetInstance(res, instanceId);
		if (method === "DELETE") return handleDeleteInstance(res, instanceId);
	}

	if (method === "GET" && url === "/health") {
		return send(res, 200, { ok: true });
	}

	send(res, 404, envelopeErr(`not found: ${method} ${url}`));
});

// ACP WebSocket endpoint — serves `ws://HOST:PORT/ws/<instanceId>?token=sk_...`
//
// The runtime client (src/cloud/cloud-runtime-client.ts) passes the token
// as `?token=<assertion>` and expects the server to accept any valid token
// and start sending RuntimeMessages. We deliberately do not enforce the
// token against anything specific — any sk_... value is accepted — the
// shape is the test surface.
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
	const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
	const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);
	if (!wsMatch) {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
		return;
	}
	const instanceId = decodeURIComponent(wsMatch[1]!);
	const instance = instances.get(instanceId);
	if (!instance || instance.state !== "ready") {
		socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
		socket.destroy();
		return;
	}
	const token = url.searchParams.get("token");
	if (!token || !token.startsWith("sk_")) {
		socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
		socket.destroy();
		return;
	}
	wss.handleUpgrade(req, socket, head, (ws) => {
		const set = activeSockets.get(instanceId) ?? new Set<WebSocket>();
		set.add(ws);
		activeSockets.set(instanceId, set);
		console.log(
			`[mock-cloud-platform] ACP WS connected: instance=${instanceId} (total=${set.size})`,
		);

		ws.on("message", (data) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data.toString("utf8"));
			} catch {
				return;
			}
			const msg = parsed as { type?: string; payload?: { text?: string } };
			console.log(
				`[mock-cloud-platform] ACP WS recv instance=${instanceId}: type=${msg.type ?? "<unknown>"}`,
			);
			if (msg.type === "user_prompt") {
				const prompt = msg.payload?.text ?? "";
				const reply = {
					type: "agent_message_chunk",
					payload: { text: `Mock agent received: ${prompt}` },
				};
				ws.send(JSON.stringify(reply));
				// Lightweight triggers so a human tester can exercise state
				// transitions in the browser without a real Cline backend:
				//   "/done"  → emit attempt_completion tool_call (→ awaiting_review, reviewReason: attention)
				//   "/ask"   → emit ask_followup_question tool_call (→ awaiting_review, reviewReason: hook)
				// Any other prompt just ends the turn.
				const lower = prompt.toLowerCase();
				setTimeout(() => {
					if (ws.readyState !== ws.OPEN) return;
					if (lower.includes("/done") || lower.includes("/complete")) {
						ws.send(
							JSON.stringify({
								type: "tool_call",
								payload: {
									name: "attempt_completion",
									args: { result: "Mock task complete." },
								},
							}),
						);
					} else if (lower.includes("/ask")) {
						ws.send(
							JSON.stringify({
								type: "tool_call",
								payload: {
									name: "ask_followup_question",
									args: { question: "Mock followup: which approach?" },
								},
							}),
						);
					}
					ws.send(JSON.stringify({ type: "turn_completed", payload: {} }));
				}, 50);
			}
		});

		ws.on("close", () => {
			set.delete(ws);
			console.log(
				`[mock-cloud-platform] ACP WS closed: instance=${instanceId} (remaining=${set.size})`,
			);
		});
	});
});

server.listen(PORT, HOST, () => {
	console.log(`[mock-cloud-platform] listening on http://${HOST}:${PORT}`);
	console.log(`[mock-cloud-platform] WS endpoint: ws://${HOST}:${PORT}/ws/<instanceId>`);
	console.log(
		`[mock-cloud-platform] Point kanban at it: KANBAN_CLOUD_PLATFORM_BASE_URL=http://${HOST}:${PORT}`,
	);
});

function shutdown() {
	console.log("\n[mock-cloud-platform] shutting down");
	for (const sockets of activeSockets.values()) {
		for (const ws of sockets) {
			try {
				ws.close(1001, "server shutdown");
			} catch {
				// ignore
			}
		}
	}
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
