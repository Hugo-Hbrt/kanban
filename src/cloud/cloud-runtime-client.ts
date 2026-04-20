// ---------------------------------------------------------------------------
// Cloud Runtime Client — ACP target path (post-Shape-B pivot)
// ---------------------------------------------------------------------------
//
// Primary runtime interaction path: WebSocket directly to the ACP pod.
// The pod is provisioned by the execution client (see cloud-platform-
// execution-client.ts) and exposes an ACP WebSocket at
// `runtime.connectUrl` (wss://<instance-hostname>/ws).
//
// No gateway. No separate connect round-trip. No per-session assertion.
// Authentication is the user's sk_ token (CLINE_API_KEY), passed as a
// `?token=` query param on the WebSocket upgrade. Same token that
// provisioned the pod; the pod's bridge validates it the same way.
//
// Flow:
//   1. connect(instanceId) → GET /api/v2/cloud-platform/instances/:id
//      → returns { runtime: { connectUrl } } from core-api
//   2. openWebSocket(connectUrl, token) → wss://.../ws?token=sk_...
//   3. Exchange ACP messages over WebSocket (prompts, tool calls, events)
//
// The HTTP path (via CloudPlatformExecutionClient) remains as a fallback
// for orchestrator-level lifecycle polling when the WebSocket can't be
// established.
// ---------------------------------------------------------------------------

import { AcpClient } from "./acp-client";
import type { CloudAuthProvider } from "./cloud-auth-provider";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RuntimeConnectRequest {
	readonly instanceId: string;
	readonly transport?: "websocket" | "http";
}

export interface RuntimeConnectResponse {
	readonly instanceId: string;
	/** sk_ token used for `?token=` WebSocket auth. Kept as `assertion` for API
	 *  stability with existing orchestrator callsites — semantically it's the
	 *  user's CLINE_API_KEY. */
	readonly assertion: string;
	readonly connectUrl: string;
	readonly transport: string;
	readonly expiresInSeconds: number;
}

export interface RuntimeMessage {
	readonly type: string;
	readonly payload: unknown;
	readonly timestamp?: string;
}

export type RuntimeConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

export interface RuntimeConnectionCallbacks {
	onMessage?: (message: RuntimeMessage) => void;
	onStateChange?: (state: RuntimeConnectionState) => void;
	onError?: (error: Error, recoverable: boolean) => void;
}

export interface CloudRuntimeClientConfig {
	/** Base URL of core-api (e.g. https://api.cline.bot). */
	readonly coreApiBaseUrl: string;
	/** Auth provider supplying the user's sk_ token (Bearer). */
	readonly authProvider: CloudAuthProvider;
	/** Custom fetch for testing. */
	readonly fetch?: typeof globalThis.fetch;
	/** WebSocket constructor for testing. */
	readonly WebSocket?: typeof globalThis.WebSocket;
}

// ---------------------------------------------------------------------------
// Client Interface
// ---------------------------------------------------------------------------

export interface CloudRuntimeClient {
	/** Authenticate with the gateway and get a runtime assertion + connect URL. */
	connect(request: RuntimeConnectRequest): Promise<RuntimeConnectResponse>;
	/** Open a WebSocket connection to the instance runtime using the assertion. */
	openWebSocket(connectUrl: string, assertion: string, callbacks: RuntimeConnectionCallbacks): RuntimeWebSocketHandle;
}

export interface RuntimeWebSocketHandle {
	/** Send a message to the instance runtime. */
	send(message: RuntimeMessage): void;
	/** Close the WebSocket connection. */
	close(): void;
	/** Current connection state. */
	readonly state: RuntimeConnectionState;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultCloudRuntimeClient implements CloudRuntimeClient {
	private readonly config: CloudRuntimeClientConfig;
	private readonly fetchFn: typeof globalThis.fetch;

	constructor(config: CloudRuntimeClientConfig) {
		this.config = config;
		this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
	}

	async connect(request: RuntimeConnectRequest): Promise<RuntimeConnectResponse> {
		const url = `${this.config.coreApiBaseUrl.replace(/\/$/, "")}/api/v2/cloud-platform/instances/${encodeURIComponent(request.instanceId)}`;
		const authHeaders = await this.config.authProvider.getAuthHeaders();

		const resp = await this.fetchFn(url, {
			method: "GET",
			headers: { ...authHeaders, "X-Service-Name": "kanban" },
		});

		if (!resp.ok) {
			const body = await resp.text();
			throw new CloudRuntimeError({
				message: `Instance lookup failed: ${resp.status} ${body}`,
				statusCode: resp.status,
				retryable: resp.status >= 500,
			});
		}

		const body = (await resp.json()) as unknown;
		const data = unwrapEnvelope(body) as {
			instanceId: string;
			runtime?: { transport: string; connectUrl: string } | null;
		} | null;
		if (!data?.runtime?.connectUrl) {
			throw new CloudRuntimeError({
				message: `Instance ${request.instanceId} has no runtime.connectUrl`,
				statusCode: 502,
				retryable: false,
			});
		}

		const assertion = extractBearerToken(authHeaders);
		return {
			instanceId: data.instanceId,
			assertion,
			connectUrl: data.runtime.connectUrl,
			transport: data.runtime.transport,
			expiresInSeconds: 0,
		};
	}

	openWebSocket(connectUrl: string, assertion: string, callbacks: RuntimeConnectionCallbacks): RuntimeWebSocketHandle {
		const WS = this.config.WebSocket ?? globalThis.WebSocket;
		return new DefaultRuntimeWebSocketHandle(WS, connectUrl, assertion, callbacks);
	}
}

// ---------------------------------------------------------------------------
// WebSocket Handle Implementation
// ---------------------------------------------------------------------------

// Google Cloud Load Balancer kills idle TCP after ~30s, so the ACP WebSocket
// to the pod drops with code 1006 whenever the agent is "thinking" (no stdout
// for a few round-trips). We ping every PING_INTERVAL_MS to keep the LB happy;
// the bridge uses coder/websocket, which auto-pongs protocol-level pings.
const PING_INTERVAL_MS = 25_000;

class DefaultRuntimeWebSocketHandle implements RuntimeWebSocketHandle {
	private ws: WebSocket | null = null;
	private _state: RuntimeConnectionState = "disconnected";
	private readonly callbacks: RuntimeConnectionCallbacks;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private acp: AcpClient | null = null;
	private acpReady = false;

	constructor(
		private readonly WS: typeof globalThis.WebSocket,
		private readonly connectUrl: string,
		private readonly assertion: string,
		callbacks: RuntimeConnectionCallbacks,
	) {
		this.callbacks = callbacks;
		this.doConnect();
	}

	get state(): RuntimeConnectionState {
		return this._state;
	}

	send(message: RuntimeMessage): void {
		if (!this.acp || !this.acpReady) {
			throw new CloudRuntimeError({
				message: "Cannot send: ACP session is not ready",
				statusCode: 0,
				retryable: false,
			});
		}
		// Fire-and-forget from the caller's perspective: the ACP client awaits
		// the full prompt turn internally and emits `turn_completed` / `turn_canceled`
		// via the onMessage callback. Surfacing errors here as onError lets the
		// orchestrator's existing WS-error fallback path take over cleanly.
		this.acp.send(message).catch((e) => {
			this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), true);
		});
	}

	close(): void {
		this.setState("disconnected");
		this.stopPingTimer();
		this.acp?.close();
		this.acp = null;
		this.acpReady = false;
		if (this.ws) {
			this.ws.close(1000, "client close");
			this.ws = null;
		}
	}

	private startPingTimer(): void {
		this.stopPingTimer();
		this.pingTimer = setInterval(() => {
			const wsAny = this.ws as unknown as { ping?: () => void } | null;
			if (!wsAny || this._state !== "connected") return;
			try {
				if (typeof wsAny.ping === "function") {
					wsAny.ping();
				}
			} catch {
				// Best-effort; onerror/onclose will surface real issues.
			}
		}, PING_INTERVAL_MS);
		const unref = (this.pingTimer as unknown as { unref?: () => void }).unref;
		if (typeof unref === "function") unref.call(this.pingTimer);
	}

	private stopPingTimer(): void {
		if (this.pingTimer) {
			clearInterval(this.pingTimer);
			this.pingTimer = null;
		}
	}

	private doConnect(): void {
		this.setState("connecting");

		// The ACP pod accepts the sk_ token via `?token=` query param (same
		// surface as bridge). The CloudRuntimeClient currently passes the
		// token in the `assertion` field for API compatibility with prior
		// gateway-era callsites.
		const url = `${this.connectUrl}?token=${encodeURIComponent(this.assertion)}`;

		try {
			this.ws = new this.WS(url);
		} catch (e) {
			this.setState("error");
			this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), false);
			return;
		}

		this.ws.onopen = () => {
			this.startPingTimer();
			// Kick off the ACP handshake. We deliberately do NOT flip the
			// connection state to "connected" yet — the orchestrator keys its
			// "send the initial prompt" behavior off onStateChange("connected"),
			// and dispatching a prompt before initialize/newSession complete
			// would race against the agent. We only transition to "connected"
			// after AcpClient.start() resolves; if it rejects we transition to
			// "error" so the orchestrator's existing fallback logic runs.
			this.startAcp();
		};

		// Inbound WS frames are consumed by the ACP client's Stream (see
		// AcpClient.buildStream, which registers its own "message" listener
		// via addEventListener). We do NOT parse RuntimeMessages off onmessage
		// here anymore — the protocol is JSON-RPC, not RuntimeMessage. The
		// ACP client translates inbound session/update notifications back to
		// RuntimeMessage shape and fans them out through onMessage.

		this.ws.onerror = (_event) => {
			this.callbacks.onError?.(new Error("WebSocket error"), true);
		};

		this.ws.onclose = (event) => {
			this.stopPingTimer();
			this.acpReady = false;
			if (this._state === "disconnected") return; // Intentional close
			if (event.code === 1000) {
				this.setState("disconnected");
			} else {
				this.setState("error");
				this.callbacks.onError?.(
					new Error(`WebSocket closed unexpectedly: ${event.code} ${event.reason}`),
					event.code !== 4001, // 4001 = auth failure, not retryable
				);
			}
		};
	}

	private startAcp(): void {
		if (!this.ws) return;
		// `ws` from the browser WebSocket API and the `ws` npm package both
		// expose addEventListener('message' | 'close' | 'error' | 'open'), so
		// we can treat the raw WebSocket as the Stream source directly. The
		// AcpClient only ever uses addEventListener, not EventEmitter-style
		// .on(), to stay env-agnostic.
		const wsLike = this.ws as unknown as import("./acp-client").AcpWebSocketLike;
		this.acp = new AcpClient({
			ws: wsLike,
			callbacks: {
				onMessage: (msg) => this.callbacks.onMessage?.(msg),
				onError: (err) => this.callbacks.onError?.(err, true),
			},
		});
		this.acp
			.start()
			.then(() => {
				this.acpReady = true;
				this.setState("connected");
			})
			.catch((e) => {
				this.acpReady = false;
				this.setState("error");
				this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), true);
			});
	}

	private setState(state: RuntimeConnectionState): void {
		if (this._state !== state) {
			this._state = state;
			this.callbacks.onStateChange?.(state);
		}
	}
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

export class CloudRuntimeError extends Error {
	readonly statusCode: number;
	readonly retryable: boolean;

	constructor(opts: { message: string; statusCode: number; retryable: boolean }) {
		super(opts.message);
		this.name = "CloudRuntimeError";
		this.statusCode = opts.statusCode;
		this.retryable = opts.retryable;
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapEnvelope(body: unknown): unknown {
	if (body !== null && typeof body === "object" && "data" in body && "success" in body) {
		return (body as { data: unknown }).data;
	}
	return body;
}

function extractBearerToken(headers: Record<string, string>): string {
	const authz = headers["Authorization"] ?? headers["authorization"] ?? "";
	const match = /^Bearer\s+(.+)$/i.exec(authz);
	return match?.[1] ?? "";
}
