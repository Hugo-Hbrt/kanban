// ---------------------------------------------------------------------------
// ACP Client — Agent Client Protocol (JSON-RPC 2.0) wrapper over a WebSocket
// ---------------------------------------------------------------------------
//
// This module speaks the ACP protocol to `cline --acp` running in a
// cloud-base pod, on top of a WebSocket established by
// `DefaultRuntimeWebSocketHandle` (see cloud-runtime-client.ts). The pod's
// bridge is a transparent byte pipe (ws://…/ws ↔ cline stdio), so the JSON-RPC
// handshake happens end-to-end between kanban and cline.
//
// Post-Shape-B there's no gateway and no envelope translator in the bridge,
// so kanban has to be a full ACP client. This wrapper does the handshake
// (`initialize` → `session/new`), translates outbound kanban RuntimeMessages
// (today: `user_prompt`) into ACP `session/prompt` requests, and translates
// inbound ACP `session/update` notifications back into the RuntimeMessage
// shape that `CloudTaskChatService` already knows how to ingest
// (`agent_message_chunk`, `tool_call`, `turn_completed`, …).
//
// Why we keep the RuntimeMessage abstraction in the orchestrator/chat-service
// instead of threading ACP types all the way up: the abstraction gives us a
// stable seam for unit testing (callers can still inject mock envelopes in
// tests that predate ACP) and a single bottleneck where we can surface
// unsupported ACP features as status messages instead of silently dropping
// them. The wrapper is the only place where ACP types are allowed to leak in.

import {
	ClientSideConnection,
	PROTOCOL_VERSION,
	type Agent,
	type Client,
	type InitializeResponse,
	type NewSessionResponse,
	type PromptResponse,
	type ReadTextFileRequest,
	type ReadTextFileResponse,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type Stream,
	type WriteTextFileRequest,
	type WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

import type { RuntimeMessage } from "./cloud-runtime-client";

// The `ws` package's WebSocket gives us .on/.send/.close/.ping with Node-native
// EventEmitter semantics. We type the subset we rely on rather than importing
// `ws` directly, so this file stays env-agnostic (browser builds won't drag
// `ws` along).
export interface AcpWebSocketLike {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	readonly readyState: number;
	addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
	addEventListener(type: "close" | "error" | "open", listener: () => void): void;
	removeEventListener(type: "message" | "close" | "error" | "open", listener: () => void): void;
}

export interface AcpClientCallbacks {
	onMessage: (message: RuntimeMessage) => void;
	onError?: (error: Error) => void;
}

export interface AcpClientOptions {
	ws: AcpWebSocketLike;
	callbacks: AcpClientCallbacks;
	workingDirectory?: string;
	clientName?: string;
	clientVersion?: string;
}

type ToolCallAccumulator = {
	toolCallId: string;
	title: string;
	kind?: string;
	status?: string;
	content: unknown[];
	rawInput?: unknown;
	locations?: unknown[];
	emitted: boolean;
};

// Cold-start interactive chat in the pod lives at /workspace (see cline-base
// Dockerfile). Kanban never ships a real directory over the wire today; if a
// future feature wants to scope the session to a repo checkout inside the pod
// we'll thread that through here.
const DEFAULT_WORKING_DIRECTORY = "/workspace";

export class AcpClient {
	private readonly ws: AcpWebSocketLike;
	private readonly callbacks: AcpClientCallbacks;
	private readonly workingDirectory: string;
	private readonly clientName: string;
	private readonly clientVersion: string;
	private readonly clientImpl: Client;

	private connection: ClientSideConnection | null = null;
	private sessionId: string | null = null;
	private started = false;
	private closed = false;
	private readStreamController: ReadableStreamDefaultController<unknown> | null = null;
	private toolCalls = new Map<string, ToolCallAccumulator>();

	constructor(options: AcpClientOptions) {
		this.ws = options.ws;
		this.callbacks = options.callbacks;
		this.workingDirectory = options.workingDirectory ?? DEFAULT_WORKING_DIRECTORY;
		this.clientName = options.clientName ?? "kanban";
		this.clientVersion = options.clientVersion ?? "0.0.0";
		this.clientImpl = this.buildClientImpl();
	}

	// Drive the ACP handshake. Call this once the WebSocket is actually open.
	// Resolves when `session/new` has returned a sessionId; rejects on any
	// protocol error during the handshake (the caller — cloud-runtime-client —
	// treats rejection as a hard connection failure and falls back to HTTP
	// polling).
	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		const stream = this.buildStream();
		const connection = new ClientSideConnection(() => this.clientImpl, stream);
		this.connection = connection;

		console.info("[acp] initialize: sending…", { protocolVersion: PROTOCOL_VERSION });
		let initResp: InitializeResponse;
		try {
			initResp = await connection.initialize({
				protocolVersion: PROTOCOL_VERSION,
				clientCapabilities: {
					// The agent is running inside the pod's /workspace directory,
					// so cline handles its own fs/terminal natively — we don't
					// advertise fs.readTextFile, fs.writeTextFile, or terminal.
					// If the pod's cline requests one of these anyway (e.g. an
					// unusual MCP config), our Client impl returns method_not_found
					// and cline's fallback path takes over.
					fs: {},
					terminal: false,
				},
				clientInfo: {
					name: this.clientName,
					version: this.clientVersion,
				},
			});
		} catch (e) {
			console.error("[acp] initialize failed:", e);
			throw new Error(`ACP initialize failed: ${e instanceof Error ? e.message : String(e)}`);
		}
		console.info("[acp] initialize ok", {
			negotiatedProtocolVersion: initResp.protocolVersion,
			agent: initResp.agentInfo,
			agentCapabilities: initResp.agentCapabilities,
		});

		console.info("[acp] session/new: sending…", { cwd: this.workingDirectory });
		let newSessionResp: NewSessionResponse;
		try {
			newSessionResp = await connection.newSession({
				cwd: this.workingDirectory,
				mcpServers: [],
			});
		} catch (e) {
			console.error("[acp] session/new failed:", e);
			throw new Error(`ACP session/new failed: ${e instanceof Error ? e.message : String(e)}`);
		}

		this.sessionId = newSessionResp.sessionId;
		console.info("[acp] session/new ok", { sessionId: this.sessionId });

		// Surface the negotiated protocol version as a status line in the chat
		// panel so it's obvious at a glance what the pod supports. Matches the
		// mental model local Cline users have where you can see the model pick.
		this.emit({
			type: "session_started",
			payload: {
				sessionId: this.sessionId,
				protocolVersion: initResp.protocolVersion,
				agentName: initResp.agentInfo?.name,
			},
		});
	}

	// Translate an outbound kanban RuntimeMessage into an ACP operation. Today
	// only `user_prompt` has a real mapping (session/prompt); everything else
	// is logged and dropped so we don't block future experimentation on adding
	// new envelope types here in lockstep.
	async send(message: RuntimeMessage): Promise<void> {
		if (this.closed) {
			throw new Error("ACP client is closed");
		}
		if (!this.connection || !this.sessionId) {
			throw new Error("ACP client not started — call start() and await it first");
		}

		switch (message.type) {
			case "user_prompt": {
				const payload = (message.payload ?? {}) as { text?: string };
				const text = payload.text ?? "";
				await this.runPromptTurn(text);
				return;
			}
			default: {
				this.callbacks.onError?.(
					new Error(`AcpClient.send: unsupported outbound message type "${message.type}" (dropped)`),
				);
				return;
			}
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		// ClientSideConnection doesn't expose a close method in the current
		// SDK — closing the underlying stream (via closing the readable
		// controller) signals it to stop reading. The WebSocket itself is
		// owned and closed by the caller (cloud-runtime-client).
		try {
			this.readStreamController?.close();
		} catch {
			// already closed
		}
		this.readStreamController = null;
	}

	// -------------------------------------------------------------------
	// Internal: prompt turn driver
	// -------------------------------------------------------------------

	private async runPromptTurn(text: string): Promise<void> {
		if (!this.connection || !this.sessionId) return;

		this.toolCalls.clear();
		console.info("[acp] session/prompt: sending…", {
			sessionId: this.sessionId,
			textPreview: text.slice(0, 80),
		});

		let resp: PromptResponse;
		try {
			resp = await this.connection.prompt({
				sessionId: this.sessionId,
				prompt: [{ type: "text", text }],
			});
		} catch (e) {
			console.error("[acp] session/prompt failed:", e);
			this.emit({
				type: "turn_canceled",
				payload: { reason: e instanceof Error ? e.message : String(e) },
			});
			return;
		}

		console.info("[acp] session/prompt completed", { stopReason: resp.stopReason });
		this.emit({
			type: "turn_completed",
			payload: { stopReason: resp.stopReason },
		});
	}

	// -------------------------------------------------------------------
	// Internal: ACP → RuntimeMessage translation
	// -------------------------------------------------------------------

	private handleSessionUpdate(params: SessionNotification): void {
		const update = params.update;
		// The spec's SessionUpdate is a tagged union keyed by `sessionUpdate`.
		// We translate the subset the chat UI actually renders today and fall
		// through unknown variants to a status message (same behavior as
		// CloudTaskChatService's default branch).
		const kind = (update as { sessionUpdate: string }).sessionUpdate;
		console.info("[acp] session/update ⇠", kind, safeJson(update).slice(0, 200));

		switch (kind) {
			case "agent_message_chunk":
			case "agent_thought_chunk": {
				const chunk = update as { content?: { type?: string; text?: string } };
				const text = chunk.content?.type === "text" ? (chunk.content.text ?? "") : "";
				if (text.length === 0) return;
				this.emit({
					type: "agent_message_chunk",
					payload: { text, thought: kind === "agent_thought_chunk" },
				});
				return;
			}
			case "user_message_chunk": {
				// The agent echoing a user message (rare — usually happens when
				// loading an existing session's transcript). We skip it because
				// kanban already shows user messages locally when the user
				// sends the prompt; re-injecting them here would duplicate.
				return;
			}
			case "tool_call": {
				const tc = update as unknown as {
					toolCallId: string;
					title?: string;
					kind?: string;
					status?: string;
					content?: unknown[];
					locations?: unknown[];
					rawInput?: unknown;
				};
				this.toolCalls.set(tc.toolCallId, {
					toolCallId: tc.toolCallId,
					title: tc.title ?? "tool",
					kind: tc.kind,
					status: tc.status,
					content: tc.content ?? [],
					locations: tc.locations,
					rawInput: tc.rawInput,
					emitted: false,
				});
				this.emitToolCall(tc.toolCallId);
				return;
			}
			case "tool_call_update": {
				const tcu = update as unknown as {
					toolCallId: string;
					title?: string;
					status?: string;
					content?: unknown[];
					rawOutput?: unknown;
				};
				const existing = this.toolCalls.get(tcu.toolCallId);
				if (existing) {
					if (tcu.title !== undefined) existing.title = tcu.title;
					if (tcu.status !== undefined) existing.status = tcu.status;
					if (tcu.content !== undefined) existing.content = tcu.content;
				}
				// A terminal status transition ("completed" / "failed") is a
				// reasonable trigger to re-emit so the UI can show the final
				// result, but we don't re-emit on every incremental chunk to
				// keep the transcript from drowning in duplicates.
				if (existing && (tcu.status === "completed" || tcu.status === "failed")) {
					this.emitToolCall(existing.toolCallId);
				}
				return;
			}
			case "plan":
			case "available_commands_update":
			case "current_mode_update":
			case "config_option_update":
			case "session_info_update":
			case "usage_update": {
				// These carry session-level metadata, not chat content. We
				// surface them as status lines so they're visible while we
				// decide whether/how to render them properly.
				this.emit({
					type: "execution_status",
					payload: { status: kind, detail: safeJson(update) },
				});
				return;
			}
			default: {
				this.emit({
					type: "execution_status",
					payload: { status: "unknown_session_update", kind, detail: safeJson(update) },
				});
				return;
			}
		}
	}

	private emitToolCall(toolCallId: string): void {
		const tc = this.toolCalls.get(toolCallId);
		if (!tc) return;
		const name = tc.title;
		const args = tc.rawInput ?? {};
		this.emit({
			type: "tool_call",
			payload: { name, args, toolCallId, status: tc.status, kind: tc.kind },
		});
		tc.emitted = true;
	}

	private emit(message: RuntimeMessage): void {
		try {
			this.callbacks.onMessage(message);
		} catch (e) {
			this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
		}
	}

	// -------------------------------------------------------------------
	// Internal: Client impl (inbound requests from the agent)
	// -------------------------------------------------------------------

	private buildClientImpl(): Client {
		return {
			sessionUpdate: async (params: SessionNotification): Promise<void> => {
				this.handleSessionUpdate(params);
			},
			requestPermission: async (
				_params: RequestPermissionRequest,
			): Promise<RequestPermissionResponse> => {
				// Until the kanban UI has an explicit "approve tool call" affordance
				// for cloud tasks, we auto-allow. This mirrors how the task-runner
				// path launches cline with --yolo and is consistent with the current
				// cloud-execution UX (the user hasn't asked to be prompted).
				// When we add UI affordance, this is the single place to wire it.
				const options = _params.options ?? [];
				const allowed =
					options.find((opt) => (opt.kind ?? "").startsWith("allow_")) ?? options[0];
				return {
					outcome: allowed
						? { outcome: "selected", optionId: allowed.optionId }
						: { outcome: "cancelled" },
				};
			},
			readTextFile: async (_params: ReadTextFileRequest): Promise<ReadTextFileResponse> => {
				throw new Error(
					"fs/read_text_file not supported: agent should use native fs in the pod workspace",
				);
			},
			writeTextFile: async (_params: WriteTextFileRequest): Promise<WriteTextFileResponse> => {
				throw new Error(
					"fs/write_text_file not supported: agent should use native fs in the pod workspace",
				);
			},
		};
	}

	// -------------------------------------------------------------------
	// Internal: WS ↔ ACP Stream bridge
	// -------------------------------------------------------------------

	// ClientSideConnection takes a Stream<AnyMessage> (a pair of
	// WritableStream/ReadableStream). We build it on top of the WebSocket:
	//   inbound WS text frames → JSON.parse → readable.enqueue
	//   writable.write → JSON.stringify → ws.send
	// The stream lifetime is tied to the WS: `close`/`error` events close the
	// readable controller, which tells the SDK to stop pumping.
	private buildStream(): Stream {
		const readable = new ReadableStream<unknown>({
			start: (controller) => {
				this.readStreamController = controller;

				const onMessage = (event: { data: unknown }) => {
					const raw = typeof event.data === "string"
						? event.data
						: event.data instanceof Uint8Array
							? new TextDecoder().decode(event.data)
							: String(event.data);
					console.info("[acp] ws ⇠", raw.slice(0, 200));
					try {
						const parsed = JSON.parse(raw);
						controller.enqueue(parsed);
					} catch (e) {
						this.callbacks.onError?.(
							new Error(
								`ACP: failed to parse inbound JSON: ${e instanceof Error ? e.message : String(e)}`,
							),
						);
					}
				};
				const onClose = () => {
					try {
						controller.close();
					} catch {
						// already closed
					}
				};

				this.ws.addEventListener("message", onMessage);
				this.ws.addEventListener("close", onClose);
				this.ws.addEventListener("error", onClose);
			},
		});

		const writable = new WritableStream<unknown>({
			write: (chunk) => {
				try {
					this.ws.send(JSON.stringify(chunk));
				} catch (e) {
					this.callbacks.onError?.(
						new Error(`ACP: failed to send: ${e instanceof Error ? e.message : String(e)}`),
					);
				}
			},
		});

		// The SDK declares Stream = { writable: WritableStream<AnyMessage>,
		// readable: ReadableStream<AnyMessage> }. AnyMessage is a generated
		// union; rather than narrow our generic bridge to it we cast at the
		// boundary — the SDK validates inbound message shape internally.
		return { readable: readable as unknown, writable: writable as unknown } as unknown as Stream;
	}
}

function safeJson(v: unknown): string {
	try {
		return JSON.stringify(v).slice(0, 256);
	} catch {
		return String(v).slice(0, 256);
	}
}

// Ensure tree-shaken builds keep the Agent type symbol — not used directly,
// but makes the module's role obvious to readers who grep for "Agent".
export type { Agent };
