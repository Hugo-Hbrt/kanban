// ---------------------------------------------------------------------------
// Cloud Execution Log Stream Client — SSE consumer for real-time execution logs
// @phase Phase2
// @prd-section 10, 15.9
//
// Connects to a remote task-runner instance's SSE log stream endpoint and
// delivers parsed log entries to the orchestrator for persistence and UI
// surfacing. Features:
//   - SSE event parsing with sequence tracking
//   - Automatic reconnect with exponential backoff on transient failures
//   - AbortSignal integration for clean shutdown
//   - Connection state change callbacks for observability
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Log Entry Types
// ---------------------------------------------------------------------------

/**
 * A single log entry received from the remote task-runner's SSE stream.
 */
export interface LogStreamEntry {
	/** Monotonically increasing sequence number within the stream. */
	readonly sequence: number;
	/** ISO-8601 timestamp from the remote runner. */
	readonly timestamp: string;
	/** Log level / severity. */
	readonly level: "info" | "warn" | "error" | "debug";
	/** Log message text. */
	readonly message: string;
	/** Optional structured metadata attached to the entry. */
	readonly metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Connection State
// ---------------------------------------------------------------------------

export type LogStreamConnectionState = "disconnected" | "connecting" | "connected" | "reconnecting" | "closed";

// ---------------------------------------------------------------------------
// Client Configuration
// ---------------------------------------------------------------------------

export interface LogStreamClientConfig {
	/** Max reconnect attempts before giving up. @default 10 */
	readonly maxReconnectAttempts: number;
	/** Base delay in ms for exponential backoff. @default 1_000 */
	readonly reconnectBaseDelayMs: number;
	/** Maximum backoff delay in ms. @default 30_000 */
	readonly reconnectMaxDelayMs: number;
	/** Backoff multiplier. @default 2 */
	readonly reconnectBackoffMultiplier: number;
	/** Request timeout for the initial SSE connection in ms. @default 10_000 */
	readonly connectTimeoutMs: number;
}

export const DEFAULT_LOG_STREAM_CONFIG: Readonly<LogStreamClientConfig> = {
	maxReconnectAttempts: 10,
	reconnectBaseDelayMs: 1_000,
	reconnectMaxDelayMs: 30_000,
	reconnectBackoffMultiplier: 2,
	connectTimeoutMs: 10_000,
};

// ---------------------------------------------------------------------------
// Callbacks
// ---------------------------------------------------------------------------

export interface LogStreamCallbacks {
	/** Called for each parsed log entry. */
	onEntry: (entry: LogStreamEntry) => void;
	/** Called when the connection state changes. */
	onConnectionStateChange?: (state: LogStreamConnectionState, detail?: string) => void;
	/** Called on non-recoverable or transient errors. */
	onError?: (error: Error, recoverable: boolean) => void;
}

// ---------------------------------------------------------------------------
// HTTP Client Abstraction (for testability)
// ---------------------------------------------------------------------------

export interface LogStreamHttpResponse {
	readonly ok: boolean;
	readonly status: number;
	readonly body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null;
}

export interface LogStreamHttpClient {
	fetch(url: string, init: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<LogStreamHttpResponse>;
}

// ---------------------------------------------------------------------------
// Delay Abstraction (for testability)
// ---------------------------------------------------------------------------

export interface LogStreamTimers {
	delay(ms: number, signal?: AbortSignal): Promise<void>;
}

const defaultTimers: LogStreamTimers = {
	delay: (ms: number, signal?: AbortSignal): Promise<void> =>
		new Promise<void>((resolve, reject) => {
			if (signal?.aborted) {
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				return;
			}
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
				},
				{ once: true },
			);
		}),
};

// ---------------------------------------------------------------------------
// SSE Line Parser
// ---------------------------------------------------------------------------

/**
 * Parse an SSE `data:` payload into a {@link LogStreamEntry}.
 * Returns `null` if the payload is not a valid JSON log entry.
 */
export function parseSSEDataLine(data: string, fallbackSequence: number): LogStreamEntry | null {
	try {
		const parsed = JSON.parse(data) as Record<string, unknown>;
		const sequence = typeof parsed.sequence === "number" ? parsed.sequence : fallbackSequence;
		const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : new Date().toISOString();
		const level = isValidLevel(parsed.level) ? parsed.level : "info";
		const message = typeof parsed.message === "string" ? parsed.message : String(parsed.message ?? "");
		if (!message) return null;
		const metadata =
			typeof parsed.metadata === "object" && parsed.metadata !== null
				? (parsed.metadata as Record<string, unknown>)
				: undefined;
		return { sequence, timestamp, level, message, metadata };
	} catch {
		if (!data.trim()) return null;
		return {
			sequence: fallbackSequence,
			timestamp: new Date().toISOString(),
			level: "info",
			message: data,
		};
	}
}

function isValidLevel(v: unknown): v is LogStreamEntry["level"] {
	return v === "info" || v === "warn" || v === "error" || v === "debug";
}

// ---------------------------------------------------------------------------
// Cloud Execution Log Stream Client
// ---------------------------------------------------------------------------

export class CloudExecutionLogStreamClient {
	private readonly hostname: string;
	private readonly executionId: string;
	private readonly taskId: string;
	private readonly config: LogStreamClientConfig;
	private readonly callbacks: LogStreamCallbacks;
	private readonly httpClient: LogStreamHttpClient;
	private readonly timers: LogStreamTimers;

	private connectionState: LogStreamConnectionState = "disconnected";
	private abortController: AbortController | null = null;
	private lastSequence = 0;
	private reconnectAttempts = 0;
	private _connected = false;

	constructor(opts: {
		hostname: string;
		executionId: string;
		taskId: string;
		config?: LogStreamClientConfig;
		callbacks: LogStreamCallbacks;
		httpClient?: LogStreamHttpClient;
		timers?: LogStreamTimers;
	}) {
		this.hostname = opts.hostname;
		this.executionId = opts.executionId;
		this.taskId = opts.taskId;
		this.config = opts.config ?? DEFAULT_LOG_STREAM_CONFIG;
		this.callbacks = opts.callbacks;
		this.httpClient = opts.httpClient ?? defaultFetchClient;
		this.timers = opts.timers ?? defaultTimers;
	}

	get state(): LogStreamConnectionState {
		return this.connectionState;
	}

	get isActive(): boolean {
		return this._connected;
	}

	get lastReceivedSequence(): number {
		return this.lastSequence;
	}

	async connect(): Promise<void> {
		if (this._connected) return;
		this._connected = true;
		this.abortController = new AbortController();
		await this.connectLoop();
	}

	disconnect(): void {
		this._connected = false;
		this.abortController?.abort();
		this.abortController = null;
		this.setConnectionState("closed");
	}

	private async connectLoop(): Promise<void> {
		while (this._connected) {
			try {
				this.setConnectionState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
				const seqBefore = this.lastSequence;
				await this.consumeStream();
				// Reset reconnect counter if the stream delivered data
				if (this.lastSequence > seqBefore) {
					this.reconnectAttempts = 0;
				}
				if (this._connected) {
					this.reconnectAttempts++;
					if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
						this.callbacks.onError?.(
							new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) exceeded`),
							false,
						);
						this.disconnect();
						return;
					}
					await this.backoffDelay();
				}
			} catch (e) {
				if (!this._connected) return;
				const error = e instanceof Error ? e : new Error(String(e));
				this.reconnectAttempts++;
				if (this.reconnectAttempts > this.config.maxReconnectAttempts) {
					this.callbacks.onError?.(error, false);
					this.disconnect();
					return;
				}
				this.callbacks.onError?.(error, true);
				await this.backoffDelay();
			}
		}
	}

	private async consumeStream(): Promise<void> {
		const signal = this.abortController?.signal;
		if (signal?.aborted) return;

		const url = `https://${this.hostname}/logs/stream?execution_id=${encodeURIComponent(this.executionId)}&last_sequence=${this.lastSequence}`;
		const response = await this.httpClient.fetch(url, {
			signal,
			headers: {
				Accept: "text/event-stream",
				"Cache-Control": "no-cache",
			},
		});

		if (!response.ok) {
			throw new Error(`SSE stream returned HTTP ${response.status}`);
		}

		this.setConnectionState("connected");

		if (!response.body) {
			throw new Error("SSE response has no body");
		}

		const reader = this.getReader(response.body);
		const decoder = new TextDecoder();
		let buffer = "";

		try {
			while (this._connected) {
				const result = await reader.read();
				if (result.done) break;

				buffer += decoder.decode(result.value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				let currentData = "";
				for (const line of lines) {
					if (line.startsWith("data:")) {
						currentData += (currentData ? "\n" : "") + line.slice(5).trimStart();
					} else if (line.trim() === "" && currentData) {
						const entry = parseSSEDataLine(currentData, this.lastSequence + 1);
						if (entry) {
							this.lastSequence = entry.sequence;
							this.callbacks.onEntry(entry);
						}
						currentData = "";
					}
				}
			}
		} finally {
			reader.cancel?.();
		}
	}

	private getReader(body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>): {
		read(): Promise<{ done: boolean; value?: Uint8Array }>;
		cancel?(): void;
	} {
		if ("getReader" in body && typeof body.getReader === "function") {
			const reader = body.getReader();
			return {
				read: () => reader.read(),
				cancel: () => reader.cancel(),
			};
		}
		const iterator = (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
		return {
			read: async () => {
				const result = await iterator.next();
				return { done: !!result.done, value: result.value };
			},
			cancel: () => {
				iterator.return?.();
			},
		};
	}

	private async backoffDelay(): Promise<void> {
		const delay = Math.min(
			this.config.reconnectBaseDelayMs * this.config.reconnectBackoffMultiplier ** (this.reconnectAttempts - 1),
			this.config.reconnectMaxDelayMs,
		);
		try {
			await this.timers.delay(delay, this.abortController?.signal);
		} catch {
			// Abort during delay — swallowed, handled by connect loop
		}
	}

	private setConnectionState(state: LogStreamConnectionState): void {
		if (this.connectionState === state) return;
		this.connectionState = state;
		this.callbacks.onConnectionStateChange?.(state);
	}
}

// ---------------------------------------------------------------------------
// Default fetch-based HTTP client
// ---------------------------------------------------------------------------

const defaultFetchClient: LogStreamHttpClient = {
	async fetch(url, init) {
		const response = await globalThis.fetch(url, {
			method: "GET",
			signal: init.signal,
			headers: init.headers,
		});
		return {
			ok: response.ok,
			status: response.status,
			body: response.body,
		};
	},
};

// ---------------------------------------------------------------------------
// Factory Interface (for orchestrator dependency injection)
// ---------------------------------------------------------------------------

/**
 * Factory for creating log stream clients. Injected into the
 * orchestrator so tests can provide mock implementations.
 */
export interface LogStreamClientFactory {
	create(opts: {
		hostname: string;
		executionId: string;
		taskId: string;
		callbacks: LogStreamCallbacks;
	}): CloudExecutionLogStreamClient;
}

/**
 * Default factory that creates real SSE clients.
 */
export const defaultLogStreamClientFactory: LogStreamClientFactory = {
	create(opts) {
		return new CloudExecutionLogStreamClient(opts);
	},
};
