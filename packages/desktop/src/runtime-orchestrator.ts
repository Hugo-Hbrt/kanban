/**
 * Runtime orchestrator — owns everything about the runtime's lifecycle.
 *
 * Responsibilities:
 *   • Health-check an origin.
 *   • On boot: attach to an existing runtime if one is reachable, otherwise
 *     spawn our own child via RuntimeChildManager.
 *   • Expose a deduplicated `restart()` for user-initiated recovery.
 *   • Re-emit crash events so the shell can flip to a disconnected screen.
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
}

interface RuntimeOrchestratorEventMap {
	/** Emitted whenever the active URL changes (connect, restart, crash). */
	"url-changed": [url: string | null];
	/** Emitted after the child crashes. Shell should show disconnected UI. */
	crashed: [];
}

export class RuntimeOrchestrator extends EventEmitter<RuntimeOrchestratorEventMap> {
	private manager: RuntimeChildManager | null = null;
	private url: string | null = null;
	private ownsChild = false;
	private restartPromise: Promise<void> | null = null;
	private powerSaveBlockerId = -1;

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

	/** Probes an origin's /api/health endpoint. */
	async checkHealth(origin: string): Promise<boolean> {
		const fetchFn = this.opts.fetchImpl ?? globalThis.fetch;
		try {
			const controller = new AbortController();
			const timer = setTimeout(
				() => controller.abort(),
				this.opts.healthTimeoutMs,
			);
			const res = await fetchFn(`${origin}/api/health`, {
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
			this.setUrl(null, /* owns */ false);
			this.emit("crashed");
		});

		manager.on("error", (message: string) => {
			console.error(`[desktop] Runtime error: ${message}`);
		});

		return manager;
	}

	private setUrl(url: string | null, ownsChild: boolean): void {
		this.url = url;
		this.ownsChild = ownsChild;
		this.emit("url-changed", url);
	}
}
