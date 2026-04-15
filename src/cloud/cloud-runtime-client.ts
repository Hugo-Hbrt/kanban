// ---------------------------------------------------------------------------
// Cloud Runtime Client — Slice 5
// ---------------------------------------------------------------------------
//
// Primary runtime interaction path using the runtime gateway + WebSocket.
// This replaces HTTP execution polling as the target runtime model.
//
// Flow:
//   1. POST /gateway/v1/instances/{instanceId}/connect → get assertion + connectUrl
//   2. Open WebSocket to connectUrl with assertion as auth
//   3. Exchange messages over WebSocket (cline-base protocol)
//
// The HTTP execution CRUD bridge path (via CloudPlatformExecutionClient) is
// preserved for backward compatibility. This client implements the target path.
// ---------------------------------------------------------------------------

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
	/** Base URL of the runtime gateway (e.g. https://cloud-platform.cline.bot). */
	readonly gatewayBaseUrl: string;
	/** Auth provider for user bearer tokens (sent to gateway). */
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
		const gatewayUrl = `${this.config.gatewayBaseUrl.replace(/\/$/, "")}/gateway/v1/instances/${request.instanceId}/connect`;
		const authHeaders = await this.config.authProvider.getAuthHeaders();

		const resp = await this.fetchFn(gatewayUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...authHeaders,
			},
			body: JSON.stringify({
				transport: request.transport ?? "websocket",
			}),
		});

		if (!resp.ok) {
			const body = await resp.text();
			throw new CloudRuntimeError({
				message: `Gateway connect failed: ${resp.status} ${body}`,
				statusCode: resp.status,
				retryable: resp.status >= 500,
			});
		}

		const data = (await resp.json()) as RuntimeConnectResponse;
		return data;
	}

	openWebSocket(connectUrl: string, assertion: string, callbacks: RuntimeConnectionCallbacks): RuntimeWebSocketHandle {
		const WS = this.config.WebSocket ?? globalThis.WebSocket;
		return new DefaultRuntimeWebSocketHandle(WS, connectUrl, assertion, callbacks);
	}
}

// ---------------------------------------------------------------------------
// WebSocket Handle Implementation
// ---------------------------------------------------------------------------

class DefaultRuntimeWebSocketHandle implements RuntimeWebSocketHandle {
	private ws: WebSocket | null = null;
	private _state: RuntimeConnectionState = "disconnected";
	private readonly callbacks: RuntimeConnectionCallbacks;

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
		if (this._state !== "connected" || !this.ws) {
			throw new CloudRuntimeError({
				message: "Cannot send: WebSocket is not connected",
				statusCode: 0,
				retryable: false,
			});
		}
		this.ws.send(JSON.stringify(message));
	}

	close(): void {
		this.setState("disconnected");
		if (this.ws) {
			this.ws.close(1000, "client close");
			this.ws = null;
		}
	}

	private doConnect(): void {
		this.setState("connecting");

		// Pass assertion as a subprotocol or query param
		// Using query param for broad compatibility
		const url = `${this.connectUrl}?assertion=${encodeURIComponent(this.assertion)}`;

		try {
			this.ws = new this.WS(url);
		} catch (e) {
			this.setState("error");
			this.callbacks.onError?.(e instanceof Error ? e : new Error(String(e)), false);
			return;
		}

		this.ws.onopen = () => {
			this.setState("connected");
		};

		this.ws.onmessage = (event) => {
			try {
				const message = JSON.parse(String(event.data)) as RuntimeMessage;
				this.callbacks.onMessage?.(message);
			} catch (e) {
				this.callbacks.onError?.(new Error(`Failed to parse message: ${e}`), true);
			}
		};

		this.ws.onerror = (_event) => {
			this.callbacks.onError?.(new Error("WebSocket error"), true);
		};

		this.ws.onclose = (event) => {
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
