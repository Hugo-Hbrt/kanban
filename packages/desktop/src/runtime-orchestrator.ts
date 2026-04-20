/**
 * Runtime orchestrator — owns everything about the runtime's lifecycle.
 *
 * Responsibilities:
 *   • Health-check an origin.
 *   • On boot: attach to an existing runtime if one is reachable, otherwise
 *     spawn our own child via RuntimeChildManager.
 *   • Expose a deduplicated `restart()` for user-initiated recovery.
 *   • Re-emit crash events so the shell can flip to a disconnected screen.
 *   • After a crash, poll the last-known origin so a runtime started from
 *     the user's terminal (`kanban`) auto-reattaches without a restart.
 *   • Manage the power-save blocker (App Nap prevention) tied to the
 *     runtime's lifetime.
 *
 * This module deliberately owns no window state — it talks to the outside
 * world via EventEmitter and getter methods, so the shell can wire it to
 * whatever UI it wants without the orchestrator knowing about BrowserWindow.
 */

import { EventEmitter } from "node:events";
import { powerSaveBlocker } from "electron";

import { RuntimeChildManager } from "./runtime-child.js";

export interface RuntimeOrchestratorOptions {
	host: string;
	port: number;
	/** Health check timeout per attempt (ms). */
	healthTimeoutMs: number;
	/** Resolved lazily so packaged vs dev mode can differ without extra plumbing. */
	resolveCliShimPath: () => string;
	/** Exposed for tests — defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/**
	 * How often to poll an attached (not-owned) runtime for liveness (ms).
	 * Defaults to 2_000. Set to 0 to disable (e.g. in tests).
	 */
	attachedProbeIntervalMs?: number;
	/**
	 * Number of consecutive probe failures before we classify an attached
	 * runtime as crashed. Defaults to 3.
	 */
	attachedProbeFailureThreshold?: number;
	/**
	 * How often the post-crash recovery probe polls the last-known origin
	 * looking for a runtime to re-appear (ms). Defaults to 2_000. Set to 0
	 * to disable the feature (e.g. in tests that would otherwise see
	 * spurious timers after a simulated crash).
	 */
	recoveryProbeIntervalMs?: number;
}

interface RuntimeOrchestratorEventMap {
	/** Emitted whenever the active URL changes (connect, restart, crash). */
	"url-changed": [url: string | null];
	/** Emitted after the child crashes. Shell should show disconnected UI. */
	crashed: [];
}

// Kept deliberately aggressive — the race we're defending against is that
// an attached runtime's bundled web-ui may render its OWN "disconnected"
// React fallback within milliseconds of WebSocket loss. We need to replace
// that with the native `disconnected.html` fast enough that users don't
// see a stale message. 500 ms × 2 ≈ ~1 s worst-case flip, versus the
// healthTimeoutMs budget per probe (3 s), which dominates the observed
// latency when the TCP connect fails fast (ECONNREFUSED is immediate).
const DEFAULT_ATTACHED_PROBE_INTERVAL_MS = 500;
const DEFAULT_ATTACHED_PROBE_FAILURE_THRESHOLD = 2;

// The disconnected screen advertises "run kanban in any terminal" as a
// recovery path, so users reasonably expect the desktop to reconnect on
// its own. 2 s feels snappy without being chatty — the probe costs one
// fetch per interval and only runs while we're actually disconnected.
const DEFAULT_RECOVERY_PROBE_INTERVAL_MS = 2_000;

export class RuntimeOrchestrator extends EventEmitter<RuntimeOrchestratorEventMap> {
	private manager: RuntimeChildManager | null = null;
	private url: string | null = null;
	private ownsChild = false;
	private restartPromise: Promise<void> | null = null;
	private powerSaveBlockerId = -1;
	private attachedProbeTimer: NodeJS.Timeout | null = null;
	private attachedProbeFailures = 0;
	private recoveryProbeTimer: NodeJS.Timeout | null = null;
	/**
	 * Last origin we were successfully connected to. Remembered across
	 * crash → reconnect cycles so the post-crash recovery probe knows
	 * which URL to watch for a returning runtime.
	 */
	private lastKnownOrigin: string | null = null;

	constructor(private readonly opts: RuntimeOrchestratorOptions) {
		super();
	}


	/** Current runtime URL, or null if disconnected. */
	getUrl(): string | null {
		return this.url;
	}

	/** True if we spawned the child (vs attached to an existing runtime). */
	isOwned(): boolean {
		return this.ownsChild;
	}

	/** Default origin used for initial attach probes. */
	defaultOrigin(): string {
		return `http://${this.opts.host}:${this.opts.port}`;
	}

	/**
	 * Probes an origin to detect whether a Kanban runtime is listening.
	 *
	 * Uses `/` instead of `/api/health` because the CLI runtime doesn't
	 * implement `/api/health` — it only serves the web UI at `/`. A 2xx
	 * response from `/` is sufficient proof that a runtime is reachable.
	 */
	async checkHealth(origin: string): Promise<boolean> {
		const fetchFn = this.opts.fetchImpl ?? globalThis.fetch;
		try {
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(),
				this.opts.healthTimeoutMs,
			);
			const res = await fetchFn(`${origin}/`, {
				signal: controller.signal,
			});
			clearTimeout(timer);
			return res.ok;
		} catch {
			return false;
		}
	}

	/**
	 * Boot the runtime: attach to any existing server on the default port,
	 * otherwise spawn our own child. Sets {@link getUrl} on success; throws
	 * on spawn failure (caller should show a startup error dialog).
	 */
	async connect(): Promise<void> {
		const origin = this.defaultOrigin();
		if (await this.checkHealth(origin)) {
			console.log(`[desktop] Found existing runtime at ${origin}`);
			this.setUrl(origin, /* owns */ false);
			return;
		}
		console.log("[desktop] No runtime found — starting child process.");
		await this.startOwnRuntime();
	}

	/**
	 * User-initiated restart. Tears down the current child (if any), spawns
	 * a fresh one, and updates the URL. Concurrent calls coalesce onto a
	 * single in-flight attempt.
	 */
	async restart(): Promise<void> {
		if (this.restartPromise) {
			await this.restartPromise;
			return;
		}
		// A user-initiated restart supersedes any passive recovery attempt.
		// Stop the recovery timer before teardown so it can't race with the
		// new child coming up on the same origin.
		this.stopRecoveryProbe();
		this.restartPromise = (async () => {
			if (this.manager) {
				await this.manager.shutdown().catch(() => {});
				this.manager = null;
			}
			await this.startOwnRuntime();
		})().finally(() => {
			this.restartPromise = null;
		});
		await this.restartPromise;
	}

	/** Graceful shutdown for `before-quit`. No-op if we don't own the child. */
	async shutdown(): Promise<void> {
		this.stopAppNapPrevention();
		if (this.manager && this.ownsChild) {
			await this.manager.shutdown().catch((err) => {
				console.error(
					"[desktop] Runtime shutdown error:",
					err instanceof Error ? err.message : err,
				);
			});
		}
	}

	/** Final cleanup for `will-quit`. */
	async dispose(): Promise<void> {
		this.stopRecoveryProbe();
		this.stopAttachedProbe();
		if (this.manager) {
			await this.manager.dispose().catch(() => {});
			this.manager = null;
		}
	}


	startAppNapPrevention(): void {
		if (this.powerSaveBlockerId !== -1) return;
		this.powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
	}

	stopAppNapPrevention(): void {
		if (this.powerSaveBlockerId === -1) return;
		powerSaveBlocker.stop(this.powerSaveBlockerId);
		this.powerSaveBlockerId = -1;
	}

	private async startOwnRuntime(): Promise<void> {
		if (!this.manager) {
			this.manager = this.createManager();
		}
		const url = await this.manager.start({
			host: this.opts.host,
			port: this.opts.port,
		});
		this.setUrl(url, /* owns */ true);
	}

	private createManager(): RuntimeChildManager {
		const manager = new RuntimeChildManager({
			cliPath: this.opts.resolveCliShimPath(),
			shutdownTimeoutMs: 5_000,
		});

		manager.on("crashed", (exitCode, signal, stderrTail) => {
			console.error(
				`[desktop] Runtime crashed (code=${exitCode}, signal=${signal})`,
			);
			if (stderrTail.trim().length > 0) {
				// The tail is capped at ~8 KB by RuntimeChildManager; safe
				// to log in one go. This is invaluable for diagnosing a
				// CLI that died before becoming reachable (the most common
				// class of desktop-only packaging failure).
				console.error(`[desktop] Runtime stderr tail:\n${stderrTail}`);
			}
			this.handleCrash();
		});

		manager.on("error", (message: string) => {
			console.error(`[desktop] Runtime error: ${message}`);
		});

		return manager;
	}

	/**
	 * Shared crash path used by both owned-child exits and attached-probe
	 * failure detection. Clears the URL, emits "crashed" so the shell can
	 * flip to disconnected.html, and kicks off the recovery probe so a
	 * runtime started from the user's terminal auto-reattaches.
	 */
	private handleCrash(): void {
		this.setUrl(null, /* owns */ false);
		this.emit("crashed");
		this.startRecoveryProbe();
	}

	private setUrl(url: string | null, ownsChild: boolean): void {
		if (url) {
			this.lastKnownOrigin = url;
			// Any successful connection supersedes an in-flight recovery
			// attempt — whether the user manually restarted, an attach
			// succeeded, or our own recovery probe just flipped us back.
			this.stopRecoveryProbe();
		}
		this.url = url;
		this.ownsChild = ownsChild;
		this.emit("url-changed", url);

		// We only poll in attached mode. When we own the child, the
		// RuntimeChildManager emits "crashed" directly from the process
		// exit event — no polling needed.
		if (url && !ownsChild) {
			this.startAttachedProbe(url);
		} else {
			this.stopAttachedProbe();
		}
	}

	/**
	 * Starts polling an attached runtime for liveness. When it fails
	 * N consecutive times, emit "crashed" so the shell can flip to the
	 * disconnected screen — same UX as an owned-child crash.
	 *
	 * Without this, a user who started the runtime from their terminal
	 * and then killed it would be stranded on the last-rendered page with
	 * no visual feedback from the desktop shell, forcing them to rely on
	 * whatever fallback the web-ui happens to render (which varies by
	 * version and is historically inconsistent).
	 */
	private startAttachedProbe(origin: string): void {
		this.stopAttachedProbe();
		const intervalMs =
			this.opts.attachedProbeIntervalMs ?? DEFAULT_ATTACHED_PROBE_INTERVAL_MS;
		if (intervalMs <= 0) return;

		const threshold =
			this.opts.attachedProbeFailureThreshold ??
			DEFAULT_ATTACHED_PROBE_FAILURE_THRESHOLD;
		this.attachedProbeFailures = 0;

		const tick = async (): Promise<void> => {
			// Guard against a stale timer firing after the URL changed.
			if (this.url !== origin || this.ownsChild) return;
			const healthy = await this.checkHealth(origin);
			if (this.url !== origin || this.ownsChild) return;
			if (healthy) {
				this.attachedProbeFailures = 0;
				return;
			}
			this.attachedProbeFailures += 1;
			if (this.attachedProbeFailures >= threshold) {
				console.error(
					`[desktop] Attached runtime at ${origin} unreachable after ${this.attachedProbeFailures} probes — classifying as crashed.`,
				);
				this.stopAttachedProbe();
				this.handleCrash();
			}
		};

		this.attachedProbeTimer = setInterval(() => {
			void tick();
		}, intervalMs);
		// Don't let the probe keep the Node event loop alive on its own.
		this.attachedProbeTimer.unref?.();
	}

	private stopAttachedProbe(): void {
		if (this.attachedProbeTimer) {
			clearInterval(this.attachedProbeTimer);
			this.attachedProbeTimer = null;
		}
		this.attachedProbeFailures = 0;
	}

	/**
	 * Starts polling the last-known origin looking for a Kanban runtime
	 * to re-appear (typically because the user ran `kanban` in a terminal).
	 * On the first healthy probe, flips back into attached mode — the
	 * existing `url-changed` listener in the shell reloads every window
	 * away from the disconnected screen.
	 *
	 * No-op if we've never connected (nothing to recover to) or if
	 * `recoveryProbeIntervalMs` is 0.
	 */
	private startRecoveryProbe(): void {
		this.stopRecoveryProbe();
		const origin = this.lastKnownOrigin;
		if (!origin) return;
		const intervalMs =
			this.opts.recoveryProbeIntervalMs ?? DEFAULT_RECOVERY_PROBE_INTERVAL_MS;
		if (intervalMs <= 0) return;

		const tick = async (): Promise<void> => {
			// Stop chasing if anything else reconnected us (user clicked
			// Restart, deep-link handler forced a re-attach, etc.).
			if (this.url !== null) {
				this.stopRecoveryProbe();
				return;
			}
			const healthy = await this.checkHealth(origin);
			if (this.url !== null) return;
			if (!healthy) return;
			console.log(
				`[desktop] Recovery probe found runtime at ${origin} — auto-attaching.`,
			);
			// setUrl() will stop this recovery timer and promote us to
			// attached-probe mode.
			this.setUrl(origin, /* owns */ false);
		};

		this.recoveryProbeTimer = setInterval(() => {
			void tick();
		}, intervalMs);
		this.recoveryProbeTimer.unref?.();
	}

	private stopRecoveryProbe(): void {
		if (this.recoveryProbeTimer) {
			clearInterval(this.recoveryProbeTimer);
			this.recoveryProbeTimer = null;
		}
	}
}
