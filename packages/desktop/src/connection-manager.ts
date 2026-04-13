/**
 * ConnectionManager — orchestrates switching between local and remote
 * Kanban server connections.
 *
 * Architecture: the local runtime child is ALWAYS running. Switching to
 * remote only changes which URL the renderer points at — the local child
 * stays alive for instant fallback.
 *
 * Responsibilities:
 * - Local child lifecycle: start once during initialize(), keep alive
 *   until shutdown(). Never kill the child when switching connections.
 * - Remote switching: health-check the remote first, only then navigate
 *   the renderer. If the remote is unreachable, auto-fallback to local.
 * - HTTP warning: warn before connecting to non-localhost http:// URLs.
 * - Auth token injection via session.webRequest.onBeforeSendHeaders.
 *
 * Fallback behavior (required by connection architecture):
 * If the saved connection is invalid (deleted, unreachable, or auth fails),
 * the app should:
 *   1. Log a warning
 *   2. Fall back to local connection
 *   3. Update the persisted active connection to local
 *   4. Not crash or hang
 */

import http from "node:http";
import https from "node:https";
import { BrowserWindow, dialog } from "electron";
import type { RuntimeChildManager } from "./runtime-child.js";
import type { ConnectionStore, SavedConnection } from "./connection-store.js";
import { generateAuthToken } from "./auth.js";
import { isInsecureRemoteUrl } from "./connection-utils.js";
import { getBootState, recordBootFailure } from "./desktop-boot-state.js";
import { showDesktopFailureDialog, type DesktopFailureState } from "./desktop-failure.js";

// Re-export for convenience.
export { isInsecureRemoteUrl } from "./connection-utils.js";

/** Timeout for remote health checks (ms). */
const REMOTE_HEALTH_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectionManagerOptions {
	childManager: RuntimeChildManager;
	store: ConnectionStore;
	onConnectionChanged?: () => void;
	/**
	 * Absolute path to the bundled Kanban CLI shim.
	 * Passed to the child process so the home-agent prompt references
	 * the bundled shim instead of relying on a global install.
	 */
	kanbanCliCommand?: string;
	/**
	 * Called when the local runtime becomes ready with its URL and auth token.
	 * Used by main.ts to publish the runtime descriptor for CLI discovery.
	 */
	onLocalRuntimeReady?: (url: string, authToken: string) => void;
	/**
	 * Called when the local runtime is being stopped (switching away or shutting down).
	 * Used by main.ts to clear the runtime descriptor.
	 */
	onLocalRuntimeStopped?: () => void;
	/**
	 * Returns the BrowserWindow to use as the parent for dialog boxes.
	 * Typically wired to `windowRegistry.getFocused()`.
	 */
	getDialogParent?: () => BrowserWindow | null;
	/**
	 * Navigate all renderer windows to the given URL.
	 * Called after auth has been installed and the connection is ready.
	 */
	onLoadUrl?: (url: string) => Promise<void>;
	/**
	 * Install the auth interceptor for the given server URL and token.
	 * Called before loadURL so that requests carry the correct credentials.
	 */
	onInstallAuth?: (serverUrl: string, token: string) => Promise<void>;
	/**
	 * Remove all auth interceptors.
	 */
	onRemoveAuth?: () => void;
}

// ---------------------------------------------------------------------------
// ConnectionManager
// ---------------------------------------------------------------------------

export class ConnectionManager {
	private readonly childManager: RuntimeChildManager;
	private readonly store: ConnectionStore;
	private readonly onConnectionChanged?: () => void;

	private localAuthToken = "";
	private localUrl = "";
	private childRunning = false;

	private readonly onLocalRuntimeReady?: (url: string, authToken: string) => void;
	private readonly onLocalRuntimeStopped?: () => void;

	private readonly kanbanCliCommand?: string;
	private readonly getDialogParent: () => BrowserWindow | null;
	private readonly onLoadUrl: (url: string) => Promise<void>;
	private readonly onInstallAuth: (serverUrl: string, token: string) => Promise<void>;
	private readonly onRemoveAuth: () => void;

	constructor(options: ConnectionManagerOptions) {
		this.childManager = options.childManager;
		this.store = options.store;
		this.onConnectionChanged = options.onConnectionChanged;
		this.kanbanCliCommand = options.kanbanCliCommand;
		this.onLocalRuntimeReady = options.onLocalRuntimeReady;
		this.onLocalRuntimeStopped = options.onLocalRuntimeStopped;
		this.getDialogParent = options.getDialogParent ?? (() => null);
		this.onLoadUrl = options.onLoadUrl ?? (() => Promise.resolve());
		this.onInstallAuth = options.onInstallAuth ?? (() => Promise.resolve());
		this.onRemoveAuth = options.onRemoveAuth ?? (() => {});
	}

	/**
	 * Switch to the given connection ID.
	 *
	 * If the target connection fails (e.g. remote is unreachable and user
	 * picks "fallback to local"), the active connection will reflect where
	 * the renderer actually ended up, not the originally requested target.
	 */
	async switchTo(connectionId: string): Promise<void> {
		const connection = this.store
			.getConnections()
			.find((c) => c.id === connectionId);
		if (!connection) return;

		if (connection.id === "local") {
			await this.switchToLocal();
			this.store.setActiveConnection("local");
		} else {
			// switchToRemote handles its own store updates:
			// - success → sets to connectionId
			// - fallback-to-local → sets to "local"
			// - dismiss → no change (stays on previous connection)
			await this.switchToRemote(connection);
		}

		this.onConnectionChanged?.();
	}

	/**
	 * Initialize — always start the local child, then restore the
	 * persisted active connection.
	 *
	 * The local child is started unconditionally so it's always available
	 * as a fallback. If the active connection is remote, we health-check
	 * first and silently fall back to local if unreachable.
	 */
	async initialize(): Promise<void> {
		// Always start the local child first.
		await this.ensureLocalChildRunning();
		if (!this.childRunning) return; // Boot failure was recorded; nothing to load.

		const active = this.store.getActiveConnection();
		if (active.id === "local") {
			await this.loadLocal();
		} else {
			// Remote — health-check first, auto-fallback on failure.
			const healthy = await this.checkRemoteHealth(active.serverUrl, active.authToken);
			if (healthy) {
				try {
					await this.loadRemote(active);
				} catch (err) {
					console.warn(
						`[ConnectionManager] Failed to load remote "${active.label}", falling back to local:`,
						err instanceof Error ? err.message : err,
					);
					this.store.setActiveConnection("local");
					this.onConnectionChanged?.();
					await this.loadLocal();
				}
			} else {
				console.warn(
					`[ConnectionManager] Remote "${active.label}" (${active.serverUrl}) is unreachable, falling back to local.`,
				);
				this.store.setActiveConnection("local");
				this.onConnectionChanged?.();
				await this.loadLocal();
			}
		}
	}

	/** Graceful shutdown — stop child if running. */
	async shutdown(): Promise<void> {
		if (this.childRunning) {
			this.onLocalRuntimeStopped?.();
			try {
				await this.childManager.shutdown();
			} catch {
				// Best-effort.
			}
			this.childRunning = false;
		}
		this.removeAuthInterceptor();
	}

	isChildRunning(): boolean {
		return this.childRunning;
	}

	getLocalUrl(): string {
		return this.localUrl;
	}

	getLocalAuthToken(): string {
		return this.localAuthToken;
	}

	/**
	 * Update the local runtime URL and mark the child as running.
	 *
	 * Called when the RuntimeChildManager auto-restarts the child after a
	 * crash — the child gets a new port, but the ConnectionManager's
	 * internal state still has the old URL. Without this update,
	 * `reconnectActiveConnection()` would try to load the dead old URL.
	 */
	updateLocalRuntime(url: string): void {
		this.localUrl = url;
		this.childRunning = true;
	}

	getActiveConnectionId(): string {
		return this.store.getActiveConnectionId();
	}

	/**
	 * Reconnect the active connection on all windows.
	 *
	 * Used by the activate handler to restore the active connection without
	 * going through initialize() (which is for first boot only).
	 *
	 * Uses `getActiveConnection()` (which falls back to local if the stored
	 * ID is stale) rather than `getActiveConnectionId()`.
	 */
	async reconnectActiveConnection(): Promise<void> {
		const connection = this.store.getActiveConnection();
		if (connection.id === "local") {
			if (this.childRunning) {
				try {
					await this.installAuthInterceptor(this.localUrl, this.localAuthToken);
					await this.onLoadUrl(this.localUrl);
				} catch {
					// Child may have restarted on a different port.
					await this.loadLocal();
				}
			} else {
				await this.ensureLocalChildRunning();
				await this.loadLocal();
			}
		} else {
			// Health-check remote; fallback to local if dead.
			const healthy = await this.checkRemoteHealth(connection.serverUrl, connection.authToken);
			if (healthy) {
				await this.loadRemote(connection);
			} else {
				await this.switchToLocal();
			}
		}
	}

	// -- Private: local child lifecycle ---------------------------------------

	/**
	 * Start the local child if it's not already running.
	 * Does NOT navigate the renderer — call `loadLocal()` for that.
	 */
	private async ensureLocalChildRunning(): Promise<void> {
		if (this.childRunning) return;

		// Defensive: clean up stale child reference from shutdown/exit race.
		if (this.childManager.running) {
			try { await this.childManager.shutdown(); } catch { /* best-effort */ }
		}

		this.localAuthToken = generateAuthToken();
		try {
			this.localUrl = await this.childManager.start({
				host: "127.0.0.1",
				port: "auto",
				authToken: this.localAuthToken,
				kanbanCliCommand: this.kanbanCliCommand,
			});
			this.childRunning = true;
			this.onLocalRuntimeReady?.(this.localUrl, this.localAuthToken);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[ConnectionManager] Failed to start local runtime:", message);

			const failure: DesktopFailureState = {
				code: "RUNTIME_CHILD_START_FAILED",
				title: "Local Runtime Failed",
				message: `Failed to start the Kanban runtime:\n\n${message}`,
				canRetry: true,
				canFallbackToLocal: false,
			};

			const parentWindow = this.getDialogParent();
			const action = parentWindow
				? await showDesktopFailureDialog(parentWindow, failure)
				: "dismiss";
			if (action === "retry") {
				return this.ensureLocalChildRunning();
			}
			// 'dismiss' — record failure ONLY after the user has given up.
			recordBootFailure("RUNTIME_CHILD_START_FAILED", message);
		}
	}

	/**
	 * Navigate all renderer windows to the local runtime URL.
	 * Assumes the local child is already running.
	 */
	private async loadLocal(): Promise<void> {
		await this.installAuthInterceptor(this.localUrl, this.localAuthToken);
		await this.onLoadUrl(this.localUrl);
	}

	// -- Private: remote health check ----------------------------------------

	/**
	 * Check if a remote server is reachable by hitting /api/health.
	 * Returns true if the server responds with 200 within the timeout.
	 */
	private async checkRemoteHealth(serverUrl: string, authToken?: string): Promise<boolean> {
		try {
			const url = new URL("/api/health", serverUrl);
			const headers: Record<string, string> = {};
			if (authToken) {
				headers["Authorization"] = `Bearer ${authToken}`;
			}

			const transport = url.protocol === "https:" ? https : http;

			return await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => {
					req.destroy();
					resolve(false);
				}, REMOTE_HEALTH_TIMEOUT_MS);

				const req = transport.get(url, { headers }, (res) => {
					clearTimeout(timer);
					// Drain the response body so the socket closes cleanly.
					res.resume();
					resolve(res.statusCode === 200);
				});
				req.on("error", () => {
					clearTimeout(timer);
					resolve(false);
				});
			});
		} catch {
			return false;
		}
	}

	// -- Private switching ----------------------------------------------------

	private async switchToLocal(): Promise<void> {
		await this.ensureLocalChildRunning();
		await this.loadLocal();
	}

	/**
	 * Navigate all renderer windows to a remote server URL.
	 * Does NOT shut down the local child — it stays alive for fallback.
	 */
	private async loadRemote(connection: SavedConnection): Promise<void> {
		const token = connection.authToken ?? "";
		await this.installAuthInterceptor(connection.serverUrl, token);
		await this.onLoadUrl(connection.serverUrl);
	}

	private async switchToRemote(connection: SavedConnection): Promise<void> {
		const parentWindow = this.getDialogParent();
		if (isInsecureRemoteUrl(connection.serverUrl) && parentWindow) {
			const { response } = await dialog.showMessageBox(parentWindow, {
				type: "warning",
				title: "Insecure Connection",
				message:
					`The connection "${connection.label}" uses unencrypted HTTP:\n\n` +
					`${connection.serverUrl}\n\n` +
					"Your auth token and data will be sent in plain text. " +
					"Only use HTTP for localhost.\n\nContinue?",
				buttons: ["Cancel", "Connect Anyway"],
				defaultId: 0,
				cancelId: 0,
			});
			if (response === 0) return;
		}

		// Health-check the remote before navigating.
		const healthy = await this.checkRemoteHealth(connection.serverUrl, connection.authToken);
		if (!healthy) {
			const failure: DesktopFailureState = {
				code: "REMOTE_CONNECTION_UNREACHABLE",
				title: "Remote Connection Failed",
				message: `Cannot reach "${connection.label}" at:\n\n${connection.serverUrl}\n\nThe server may be offline or unreachable.`,
				canRetry: true,
				canFallbackToLocal: true,
			};

			const dialogParent = this.getDialogParent();
			const action = dialogParent
				? await showDesktopFailureDialog(dialogParent, failure)
				: "dismiss";
			if (action === "retry") {
				return this.switchToRemote(connection);
			}
			if (action === "fallback-local") {
				this.store.setActiveConnection("local");
				this.onConnectionChanged?.();
				return this.loadLocal();
			}
			// 'dismiss' — only record boot failure during boot.
			if (!getBootState().failureCode && getBootState().currentPhase !== "ready") {
				recordBootFailure("REMOTE_CONNECTION_UNREACHABLE", "Health check failed");
			}
			return;
		}

		// Remote is healthy — navigate the renderer (local child stays alive).
		try {
			await this.loadRemote(connection);
			this.store.setActiveConnection(connection.id);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error("[ConnectionManager] Failed to connect to remote:", message);

			const failure: DesktopFailureState = {
				code: "REMOTE_CONNECTION_UNREACHABLE",
				title: "Remote Connection Failed",
				message: `Failed to connect to "${connection.label}":\n\n${message}`,
				canRetry: true,
				canFallbackToLocal: true,
			};

			const dialogParent2 = this.getDialogParent();
			const action = dialogParent2
				? await showDesktopFailureDialog(dialogParent2, failure)
				: "dismiss";
			if (action === "retry") {
				return this.switchToRemote(connection);
			}
			if (action === "fallback-local") {
				this.store.setActiveConnection("local");
				this.onConnectionChanged?.();
				return this.loadLocal();
			}
			if (!getBootState().failureCode && getBootState().currentPhase !== "ready") {
				recordBootFailure("REMOTE_CONNECTION_UNREACHABLE", message);
			}
			return;
		}
	}

	// -- Private auth ---------------------------------------------------------

	private async installAuthInterceptor(serverUrl: string, token: string): Promise<void> {
		this.removeAuthInterceptor();
		if (!token || !serverUrl) return;
		await this.onInstallAuth(serverUrl, token);
	}

	private removeAuthInterceptor(): void {
		this.onRemoveAuth();
	}
}
