/**
 * Electron main process entry point.
 *
 * Responsibilities:
 * - Single instance enforcement via app.requestSingleInstanceLock()
 * - Multi-window support via WindowRegistry
 * - RuntimeChildManager lifecycle (start, heartbeat, shutdown)
 * - Ephemeral auth token generation + header injection (per-window)
 * - Custom application menu with Window submenu
 * - macOS App Nap / Linux suspend prevention, Dock reactivation
 * - powerMonitor resume health check
 * - Window state persistence to userData/window-states.json
 * - Interrupted tasks notification on restart
 * - kanban:// custom protocol for OAuth deep-links
 * - IPC: open-project-window for renderer-initiated new windows
 */

import {
	BrowserWindow,
	Menu,
	app,
	dialog,
	ipcMain,
	powerMonitor,
	powerSaveBlocker,
	shell,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ConnectionManager } from "./connection-manager.js";
import { installConnectionMenu } from "./connection-menu.js";
import { ConnectionStore } from "./connection-store.js";
import {
	advanceBootPhase,
	getBootState,
	recordBootFailure,
	resetBootState,
} from "./desktop-boot-state.js";
import { runDesktopPreflight, type DesktopPreflightResult } from "./desktop-preflight.js";
import {
	extractProtocolUrlFromArgv,
	parseProtocolUrl,
	registerProtocol,
} from "./protocol-handler.js";
import { relayOAuthCallback } from "./oauth-relay.js";
import { attemptOrphanCleanup } from "./orphan-cleanup.js";
import { attachRendererRecoveryHandlers } from "./renderer-recovery.js";
import { RuntimeChildManager } from "./runtime-child.js";
import { WindowRegistry } from "./window-registry.js";
import {
	clearRuntimeDescriptor,
	evaluateDescriptorTrust,
	readRuntimeDescriptor,
	writeRuntimeDescriptor,
} from "kanban";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKGROUND_COLOR = "#1F2428";
const RUNTIME_HEALTH_TIMEOUT_MS = 3_000;

// ---------------------------------------------------------------------------
// Desktop session identity — unique per app launch, used to detect stale
// descriptors left behind by a prior desktop session that crashed.
// ---------------------------------------------------------------------------

const desktopSessionId: string = randomUUID();

/**
 * Set to `true` when a terminal-owned runtime descriptor is detected at boot.
 * While true the desktop must NOT overwrite or clear the descriptor — the CLI
 * runtime owns it and agent tasks depend on it to discover the server.
 */
let terminalOwnsDescriptor = false;

// ---------------------------------------------------------------------------
// Runtime descriptor helpers
// ---------------------------------------------------------------------------

/** Interval handle for the descriptor watcher (null when not running). */
let descriptorWatcherInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Poll the runtime descriptor every few seconds. When a terminal-owned
 * descriptor disappears (CLI shuts down), the desktop takes over by
 * publishing its own descriptor so agents can discover it.
 */
function startDescriptorWatcher(): void {
	if (descriptorWatcherInterval) return; // already running

	descriptorWatcherInterval = setInterval(() => {
		void (async () => {
			try {
				const descriptor = await readRuntimeDescriptor();

		if (!descriptor || descriptor.source !== "terminal") {
			// CLI's descriptor is gone — desktop takes over.
					terminalOwnsDescriptor = false;
					stopDescriptorWatcher();

					if (runtimeUrl && authToken) {
						console.log(
							"[desktop] Terminal descriptor disappeared — " +
								"publishing desktop descriptor.",
						);
						await publishRuntimeDescriptor(runtimeUrl, authToken);
					}
				}
			} catch {
				// Best effort — don't crash on read errors.
			}
		})();
	}, 3_000);
}

function stopDescriptorWatcher(): void {
	if (descriptorWatcherInterval) {
		clearInterval(descriptorWatcherInterval);
		descriptorWatcherInterval = null;
	}
}

async function publishRuntimeDescriptor(url: string, token: string): Promise<void> {
	try {
		await writeRuntimeDescriptor({
			url,
			authToken: token,
			pid: process.pid,
			updatedAt: new Date().toISOString(),
			source: "desktop",
			desktopSessionId,
		});
	} catch {
		// Best effort.
	}
}

// ---------------------------------------------------------------------------
// Interrupted tasks detection
// ---------------------------------------------------------------------------

async function detectInterruptedTasks(): Promise<{
	count: number;
	workspacePaths: string[];
}> {
	return { count: 0, workspacePaths: [] };
}


// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function isRuntimeAvailable(): boolean {
	if (!connectionManager) return false;
	const boot = getBootState();
	if (boot.failureCode) return false;
	if (boot.currentPhase !== "ready") return false;
	return true;
}

/** Build the application menu template. */
function buildMenuTemplate(): Electron.MenuItemConstructorOptions[] {
	const isMac = process.platform === "darwin";
	const runtimeReady = isRuntimeAvailable();

	const appMenu: Electron.MenuItemConstructorOptions = {
		label: app.name,
		submenu: [
			{ role: "about" },
			{ type: "separator" },
			{ role: "services" },
			{ type: "separator" },
			{ role: "hide" },
			{ role: "hideOthers" },
			{ role: "unhide" },
			{ type: "separator" },
			{ role: "quit" },
		],
	};

	const fileMenu: Electron.MenuItemConstructorOptions = {
		label: "File",
		submenu: [
			{
				label: "New Window",
				accelerator: isMac ? "CmdOrCtrl+Shift+N" : "Ctrl+Shift+N",
			click: () => {
				// Extract the current project from the focused window's URL
				// pathname (e.g. "/my-project") — NOT as a locked projectId.
				const focused = windowRegistry.getFocused();
				let initialPath: string | null = null;
				if (focused && !focused.isDestroyed()) {
					try {
						const currentUrl = new URL(focused.webContents.getURL());
						if (currentUrl.pathname && currentUrl.pathname !== "/") {
							initialPath = currentUrl.pathname;
						}
					} catch {
						// best effort
					}
				}
				createAppWindow({ projectId: null, initialPath });
			},
			},
			{ type: "separator" },
			isMac ? { role: "close" } : { role: "quit" },
		],
	};

	const editMenu: Electron.MenuItemConstructorOptions = {
		label: "Edit",
		submenu: [
			{ role: "undo", enabled: runtimeReady },
			{ role: "redo", enabled: runtimeReady },
			{ type: "separator" },
			{ role: "cut", enabled: runtimeReady },
			{ role: "copy", enabled: runtimeReady },
			{ role: "paste", enabled: runtimeReady },
			{ role: "selectAll", enabled: runtimeReady },
		],
	};

	const viewMenu: Electron.MenuItemConstructorOptions = {
		label: "View",
		submenu: [
			{ role: "reload", enabled: runtimeReady },
			...(!app.isPackaged
				? ([
					{ role: "forceReload", enabled: runtimeReady },
					{ role: "toggleDevTools" },
				] as Electron.MenuItemConstructorOptions[])
				: []),
			{ type: "separator" },
			{ role: "resetZoom", enabled: runtimeReady },
			{ role: "zoomIn", enabled: runtimeReady },
			{ role: "zoomOut", enabled: runtimeReady },
			{ type: "separator" },
			{ role: "togglefullscreen" },
		],
	};

	// -- Window submenu with list of open windows --
	const windowEntries = windowRegistry.getVisible();
	const windowListItems: Electron.MenuItemConstructorOptions[] = windowEntries.map(
		(entry) => {
			const title = entry.window.isDestroyed()
				? "Kanban"
				: entry.window.getTitle() || "Kanban";
			const focused = windowRegistry.getFocused();
			return {
				label: title,
				type: "checkbox" as const,
				checked: focused?.id === entry.window.id,
				click: () => {
					if (!entry.window.isDestroyed()) {
						if (entry.window.isMinimized()) entry.window.restore();
						entry.window.focus();
					}
				},
			};
		},
	);

	const windowMenu: Electron.MenuItemConstructorOptions = {
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			...(windowListItems.length > 0
				? [
						{ type: "separator" } as Electron.MenuItemConstructorOptions,
						...windowListItems,
					]
				: []),
			...(isMac
				? [
						{ type: "separator" } as Electron.MenuItemConstructorOptions,
						{ role: "front" } as Electron.MenuItemConstructorOptions,
					]
				: [{ role: "close" } as Electron.MenuItemConstructorOptions]),
		],
	};

	const helpMenu: Electron.MenuItemConstructorOptions = {
		label: "Help",
		submenu: [
			{
				label: "Kanban Documentation",
				click: () => shell.openExternal("https://github.com/cline/kanban"),
			},
			{
				label: "Report Issue",
				click: () =>
					shell.openExternal("https://github.com/cline/kanban/issues"),
			},
			{ type: "separator" },
		],
	};

	const template: Electron.MenuItemConstructorOptions[] = [];
	if (isMac) template.push(appMenu);
	template.push(fileMenu, editMenu, viewMenu, windowMenu, helpMenu);
	return template;
}

// ---------------------------------------------------------------------------
// Main process state
// ---------------------------------------------------------------------------

/** The window registry — owns all BrowserWindow instances. */
const windowRegistry = new WindowRegistry();

/** The runtime child process manager. */
let runtimeManager: RuntimeChildManager | null = null;

/** The connection store — persists saved connections to disk. */
let connectionStore: ConnectionStore | null = null;

/** The connection manager — orchestrates switching between connections. */
let connectionManager: ConnectionManager | null = null;

/** The ephemeral auth token for the current session. */
let authToken: string | null = null;

/** The runtime URL once the child process reports ready. */
let runtimeUrl: string | null = null;

/** In-flight runtime restart promise used to deduplicate resume-triggered restarts. */
let runtimeRestartPromise: Promise<void> | null = null;

/** Preflight result — stored for diagnostics export. */
let preflightResult: DesktopPreflightResult | null = null;

/** Power save blocker ID to prevent macOS App Nap. -1 if not active. */
let powerSaveBlockerId = -1;

/** Whether `before-quit` has been signalled. */
let isQuitting = false;

app.commandLine.appendSwitch("disable-renderer-backgrounding");

// ---------------------------------------------------------------------------
// Preload path (resolved once, reused for all windows)
// ---------------------------------------------------------------------------

const preloadPath = path.join(import.meta.dirname, "preload.js");

// ---------------------------------------------------------------------------
// kanban:// protocol registration
// ---------------------------------------------------------------------------

registerProtocol(app);

// ---------------------------------------------------------------------------
// Auth interceptor helpers — install per-window, idempotent per session
// ---------------------------------------------------------------------------

/**
 * Track sessions that already have an auth interceptor installed.
 * Key: session partition string (or "default" for the default session).
 */
const installedAuthSessions = new Set<string>();

/**
 * Install auth interceptor on all windows' sessions.
 * Idempotent per Electron session.
 */
async function installAuthOnAllWindows(serverUrl: string, token: string): Promise<void> {
	if (!token || !serverUrl) return;

	let origin: string;
	try {
		origin = new URL(serverUrl).origin;
	} catch {
		return;
	}

	for (const entry of windowRegistry.getAll()) {
		if (entry.window.isDestroyed()) continue;
		const session = entry.window.webContents.session;
		const sessionKey = session.storagePath ?? "default";

		// Only install once per session (all windows sharing a session get it).
		if (!installedAuthSessions.has(sessionKey)) {
			const filter = { urls: [`${origin}/*`] };
			session.webRequest.onBeforeSendHeaders(
				filter,
				(
					details: { requestHeaders: Record<string, string> },
					callback: (response: { requestHeaders: Record<string, string> }) => void,
				) => {
					const headers = { ...details.requestHeaders };
					headers["Authorization"] = `Bearer ${token}`;
					callback({ requestHeaders: headers });
				},
			);

			const url = new URL(serverUrl);
			await session.cookies.set({
				url: origin,
				name: "kanban-auth",
				value: token,
				path: "/",
				httpOnly: true,
				secure: url.protocol === "https:",
				sameSite: "strict",
			});

			installedAuthSessions.add(sessionKey);

			windowRegistry.setAuthDisposer(entry.window.id, () => {
				session.webRequest.onBeforeSendHeaders(null);
				session.cookies.remove(origin, "kanban-auth").catch(() => {});
				installedAuthSessions.delete(sessionKey);
			});
		}
	}
}

/** Remove auth interceptors from all windows. */
function removeAuthFromAllWindows(): void {
	for (const entry of windowRegistry.getAll()) {
		if (entry.disposeAuth) {
			entry.disposeAuth();
			entry.disposeAuth = null;
		}
	}
	installedAuthSessions.clear();
}

// ---------------------------------------------------------------------------
// Window creation helper
// ---------------------------------------------------------------------------

/**
 * Create a new app window via the registry. Wires up recovery handlers,
 * loads the runtime URL if available, and rebuilds the menu.
 */
function createAppWindow(options: { projectId?: string | null; initialPath?: string | null; savedState?: import("./window-state.js").PersistedWindowState }): BrowserWindow {
	const window = windowRegistry.createWindow({
		projectId: options.projectId ?? null,
		savedState: options.savedState,
		preloadPath,
		isPackaged: app.isPackaged,
		backgroundColor: BACKGROUND_COLOR,
		runtimeUrl: runtimeUrl ?? undefined,
		hideOnCloseForMac: true,
		isQuitting: () => isQuitting,
		onWindowClosed: () => {
			rebuildMenu();
		},
		onWindowFocused: () => {
			rebuildMenu();
		},
	});

	// Attach renderer recovery handlers.
	attachRendererRecoveryHandlers(window, () => connectionManager);

	// If the runtime is already running, load the URL in this window.
	if (runtimeUrl && authToken) {
		let url: string;
		if (options.projectId) {
			// Locked window — use ?projectId= query param.
			url = WindowRegistry.buildWindowUrl(runtimeUrl, options.projectId);
		} else if (options.initialPath) {
			// New window with initial project via pathname (not locked).
			const parsed = new URL(runtimeUrl);
			parsed.pathname = options.initialPath;
			url = parsed.toString();
		} else {
			url = runtimeUrl;
		}
		installAuthOnAllWindows(runtimeUrl, authToken).then(() => {
			window.loadURL(url);
		}).catch((err: unknown) => {
			console.error(
				"[desktop] Failed to load URL in new window:",
				err instanceof Error ? err.message : err,
			);
		});
	}

	rebuildMenu();
	return window;
}

// ---------------------------------------------------------------------------
// Protocol URL handling
// ---------------------------------------------------------------------------

function handleProtocolUrl(raw: string): void {
	const parsed = parseProtocolUrl(raw);
	if (!parsed) {
		console.warn(`[desktop] Ignoring invalid protocol URL: ${raw}`);
		return;
	}

	console.log(
		`[desktop] Protocol URL received: path=${parsed.pathname} isOAuth=${parsed.isOAuthCallback}`,
	);

	if (!parsed.isOAuthCallback) {
		return;
	}

	if (!runtimeUrl) {
		console.warn(
			"[desktop] Received OAuth callback but runtime is not ready — dropping.",
		);
		return;
	}

	const relayTarget = new URL("/kanban-mcp/mcp-oauth-callback", runtimeUrl);
	for (const [key, value] of parsed.searchParams.entries()) {
		relayTarget.searchParams.set(key, value);
	}

	const focusedWindow = windowRegistry.getFocused();

	relayOAuthCallback(relayTarget.toString(), authToken, {
		fetch: globalThis.fetch,
		getMainWindow: () => focusedWindow,
	}).catch((err) => {
		console.error("[desktop] OAuth relay error:", err);
	});

	// Bring a window to the foreground.
	if (focusedWindow && !focusedWindow.isDestroyed()) {
		if (focusedWindow.isMinimized()) focusedWindow.restore();
		focusedWindow.show();
		focusedWindow.focus();
	}
}

// macOS: the OS delivers the URL via the open-url event.
app.on("open-url", (event, url) => {
	event.preventDefault();
	handleProtocolUrl(url);
});

// ---------------------------------------------------------------------------
// E2E state isolation — userData override
// ---------------------------------------------------------------------------

if (process.env.KANBAN_DESKTOP_USER_DATA) {
	app.setPath("userData", process.env.KANBAN_DESKTOP_USER_DATA);
}

// ---------------------------------------------------------------------------
// Second instance / --project parsing
// ---------------------------------------------------------------------------

/**
 * Parse `--project <id>` or `--project=<id>` from an argv array.
 * Returns the project ID string or null if not found / malformed.
 */
function parseProjectFromArgv(argv: string[]): string | null {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--project" && i + 1 < argv.length) {
			const value = argv[i + 1];
			if (value && !value.startsWith("-")) return value;
		}
		if (arg.startsWith("--project=")) {
			const value = arg.slice("--project=".length);
			if (value) return value;
		}
	}
	return null;
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	app.on("second-instance", (_event, argv) => {
		// Check for protocol URL first.
		const protocolUrl = extractProtocolUrlFromArgv(argv);
		if (protocolUrl) {
			handleProtocolUrl(protocolUrl);
		}

		// Check for --project flag to open a new project window.
		const projectId = parseProjectFromArgv(argv);
		if (projectId) {
			createAppWindow({ projectId });
			return;
		}

		// Default: focus an existing window.
		const focusedWindow = windowRegistry.getFocused();
		if (focusedWindow) {
			if (focusedWindow.isMinimized()) focusedWindow.restore();
			focusedWindow.focus();
		}
	});
}

// ---------------------------------------------------------------------------
// IPC: open-project-window (renderer → main)
// ---------------------------------------------------------------------------

ipcMain.on("open-project-window", (_event, projectId: string) => {
	if (typeof projectId === "string" && projectId) {
		createAppWindow({ projectId });
	}
});

// ---------------------------------------------------------------------------
// IPC: desktop persistent settings (survives port/origin changes)
// ---------------------------------------------------------------------------

function getDesktopSettingsPath(): string {
	return path.join(app.getPath("userData"), "desktop-settings.json");
}

async function loadDesktopSettings(): Promise<Record<string, string>> {
	try {
		const raw = await readFile(getDesktopSettingsPath(), "utf-8");
		return JSON.parse(raw) as Record<string, string>;
	} catch {
		return {};
	}
}

async function saveDesktopSettings(settings: Record<string, string>): Promise<void> {
	await writeFile(getDesktopSettingsPath(), JSON.stringify(settings, null, "\t"), "utf-8");
}

ipcMain.on("set-desktop-setting", (_event, key: string, value: string) => {
	if (typeof key !== "string" || typeof value !== "string") return;
	void loadDesktopSettings().then((settings) => {
		settings[key] = value;
		return saveDesktopSettings(settings);
	}).catch(() => { /* best effort */ });
});

ipcMain.handle("get-desktop-setting", async (_event, key: string): Promise<string | null> => {
	if (typeof key !== "string") return null;
	const settings = await loadDesktopSettings();
	return settings[key] ?? null;
});

// ---------------------------------------------------------------------------
// Runtime child process lifecycle
// ---------------------------------------------------------------------------

function createRuntimeChildManager(): RuntimeChildManager {
	const childScriptPath = path.join(import.meta.dirname, "runtime-child-entry.js");

	const manager = new RuntimeChildManager({
		childScriptPath,
		shutdownTimeoutMs: 5_000,
		heartbeatTimeoutMs: 15_000,
		maxRestarts: 3,
		restartDecayMs: 300_000,
	});

	manager.on("ready", (url: string) => {
		runtimeUrl = url;
		authToken = connectionManager?.getLocalAuthToken() ?? authToken;
		if (!terminalOwnsDescriptor) {
			publishRuntimeDescriptor(url, authToken!);
		}

		if (
			getBootState().currentPhase === "ready" &&
			connectionManager
		) {
			console.log("[desktop] Runtime auto-restarted after crash — updating URL and reloading renderer.");
			connectionManager.updateLocalRuntime(url);
			connectionManager.reconnectActiveConnection().catch((err: unknown) => {
				console.error(
					"[desktop] Failed to reload renderer after auto-restart:",
					err instanceof Error ? err.message : err,
				);
			});
		}
	});

	manager.on("error", (message: string) => {
		console.error(`[desktop] Runtime error: ${message}`);
		const focusedWindow = windowRegistry.getFocused();
		if (focusedWindow && !focusedWindow.isDestroyed()) {
			dialog.showErrorBox(
				"Kanban Runtime Error",
				`The runtime process encountered an error:\n\n${message}`,
			);
		}
	});

	manager.on(
		"crashed",
		(exitCode: number | null, signal: string | null) => {
			console.error(
				`[desktop] Runtime crashed (code=${exitCode}, signal=${signal})`,
			);
		},
	);

	return manager;
}

async function isRuntimeHealthy(): Promise<boolean> {
	if (!runtimeUrl) {
		return false;
	}

	const healthUrl = new URL("/api/health", runtimeUrl);
	const abortController = new AbortController();
	const timeout = setTimeout(() => {
		abortController.abort();
	}, RUNTIME_HEALTH_TIMEOUT_MS);

	try {
		const response = await fetch(healthUrl, {
			signal: abortController.signal,
			headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
		});
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function restartRuntimeChild(): Promise<void> {
	if (runtimeRestartPromise) {
		await runtimeRestartPromise;
		return;
	}

	runtimeRestartPromise = (async () => {
		resetBootState();
		advanceBootPhase("preflight");
		rebuildMenu();

		if (!connectionManager) {
			console.error("[desktop] Cannot restart: connectionManager is not initialized.");
			recordBootFailure("UNKNOWN_STARTUP_FAILURE", "ConnectionManager unavailable during restart");
			rebuildMenu();
			return;
		}

		try {
			await connectionManager.shutdown();
		} catch {
			// best-effort
		}

		advanceBootPhase("initialize-connections");
		await connectionManager.initialize();

		if (!getBootState().failureCode) {
			advanceBootPhase("ready");
		}
		rebuildMenu();
	})().finally(() => {
		runtimeRestartPromise = null;
	});

	await runtimeRestartPromise;
}

// ---------------------------------------------------------------------------
// App Nap / suspend prevention
// ---------------------------------------------------------------------------

function startAppNapPrevention(): void {
	if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") return;
	if (powerSaveBlockerId !== -1) return;
	powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
}

function stopAppNapPrevention(): void {
	if (powerSaveBlockerId === -1) return;
	powerSaveBlocker.stop(powerSaveBlockerId);
	powerSaveBlockerId = -1;
}

// ---------------------------------------------------------------------------
// powerMonitor: health check on resume from sleep
// ---------------------------------------------------------------------------

function setupPowerMonitorHealthCheck(): void {
	powerMonitor.on("resume", () => {
		const activeId = connectionManager?.getActiveConnectionId() ?? "local";
		if (activeId !== "local") return;

		if (runtimeManager?.running) {
			runtimeManager.send({ type: "heartbeat-ack" });
			void isRuntimeHealthy().then(async (healthy) => {
				if (healthy) {
					return;
				}
				console.warn("[desktop] Runtime health check failed after resume; restarting runtime.");
				try {
					await restartRuntimeChild();
				} catch (error) {
					console.error(
						"[desktop] Failed to restart runtime after resume:",
						error instanceof Error ? error.message : error,
					);
				}
			});
		} else {
			console.warn("[desktop] Runtime child not running after resume; triggering full restart.");
			void restartRuntimeChild().catch((error) => {
				console.error(
					"[desktop] Failed to restart runtime after resume (child was dead):",
					error instanceof Error ? error.message : error,
				);
			});
		}
	});
}

// ---------------------------------------------------------------------------
// Interrupted tasks notification
// ---------------------------------------------------------------------------

async function showInterruptedTasksToast(): Promise<void> {
	try {
		const info = await detectInterruptedTasks();
		if (info.count === 0) return;

		const plural = info.count === 1 ? "task was" : "tasks were";
		const workspaces =
			info.workspacePaths.length <= 3
				? info.workspacePaths.join("\n")
				: `${info.workspacePaths.slice(0, 3).join("\n")}\n\u2026and ${info.workspacePaths.length - 3} more`;

		dialog.showMessageBox({
			type: "info",
			title: "Interrupted Tasks",
			message: `${info.count} ${plural} interrupted during the last session.`,
			detail: workspaces
				? `Affected workspaces:\n${workspaces}`
				: undefined,
			buttons: ["OK"],
		});
	} catch {
		// Best-effort — never block app startup.
	}
}

// ---------------------------------------------------------------------------
// Menu rebuild helper
// ---------------------------------------------------------------------------

function rebuildMenu(): void {
	const menu = Menu.buildFromTemplate(buildMenuTemplate());
	Menu.setApplicationMenu(menu);

	// Layer the Connection submenu if everything is initialized.
	const focusedWindow = windowRegistry.getFocused();
	if (focusedWindow && connectionStore && connectionManager) {
		installConnectionMenu({
			store: connectionStore,
			manager: connectionManager,
			window: focusedWindow,
		});
	}
}

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------

if (gotTheLock) {
	app.whenReady().then(async () => {
		// ── preflight ─────────────────────────────────────────────────────
		advanceBootPhase("preflight");

		await mkdir(app.getPath("userData"), { recursive: true }).catch(
			() => {},
		);

		const childScriptPath = path.join(import.meta.dirname, "runtime-child-entry.js");
		let cliShimPath: string;
		if (app.isPackaged) {
			const shimName = process.platform === "win32" ? "kanban.cmd" : "kanban";
			cliShimPath = path.join(process.resourcesPath, "bin", shimName);
		} else {
			const devShimName = process.platform === "win32" ? "kanban-dev.cmd" : "kanban-dev";
			cliShimPath = path.join(import.meta.dirname, "..", "build", "bin", devShimName);
		}

		preflightResult = runDesktopPreflight({
			preloadPath,
			childScriptPath,
			cliShimPath,
			isPackaged: app.isPackaged,
		});

		if (!preflightResult.ok) {
			const details = preflightResult.failures
				.map((f) => `[${f.code}] ${f.message}`)
				.join("\n\n");
			recordBootFailure("PREFLIGHT_FAILED", details);
			dialog.showErrorBox(
				"Kanban Startup Error",
				`Startup preflight failed — critical resources are missing:\n\n${details}`,
			);
			return;
		}

		// ── descriptor trust check ───────────────────────────────────────
		const trustResult = await evaluateDescriptorTrust(desktopSessionId);

		switch (trustResult.reason) {
			case "pid-dead":
				console.log(
					"[desktop] Cleaned up stale descriptor from prior session (PID was dead).",
				);
				break;
			case "prior-desktop-session":
				console.warn(
					"[desktop] Found descriptor from a prior desktop session with a live PID — " +
						"attempting orphan cleanup before starting a fresh runtime.",
				);
				if (trustResult.descriptor) {
					void attemptOrphanCleanup(trustResult.descriptor).then((result) => {
						if (result.cleaned) {
							console.log(
								`[desktop] Orphan cleanup succeeded (method=${result.method}).`,
							);
						} else {
							console.warn(
								`[desktop] Orphan cleanup failed (method=${result.method}) — ` +
									"the orphaned process may still be running.",
							);
						}
					}).catch((err) => {
						console.error("[desktop] Orphan cleanup threw unexpectedly:", err);
					});
				}
				break;
		case "terminal-owned":
			terminalOwnsDescriptor = true;
			console.log(
				"[desktop] Found terminal-owned descriptor — " +
					"desktop will start its own runtime on a separate port " +
					"(descriptor writes suppressed).",
			);
			break;
			case "current-session":
				console.log("[desktop] Descriptor already belongs to this session.");
				break;
			case "no-descriptor":
				break;
		}

		// ── create windows ────────────────────────────────────────────────
		advanceBootPhase("create-window");

		// Load persisted window states and recreate windows.
		const persistedStates = WindowRegistry.loadPersistedWindows(
			app.getPath("userData"),
		);

		if (persistedStates.length > 0) {
			for (const savedState of persistedStates) {
				createAppWindow({
					projectId: savedState.projectId,
					savedState,
				});
			}
		} else {
			// First launch — create a single overview window.
			createAppWindow({ projectId: null });
		}

		// Build and apply the base application menu.
		rebuildMenu();

		// Prevent macOS App Nap.
		startAppNapPrevention();

		// ── load-persisted-state (synchronous) ────────────────────────────
		advanceBootPhase("load-persisted-state");

		connectionStore = new ConnectionStore(app.getPath("userData"));

		runtimeManager = createRuntimeChildManager();

		let kanbanCliCommand: string;
		if (app.isPackaged) {
			const shimName = process.platform === "win32" ? "kanban.cmd" : "kanban";
			kanbanCliCommand = path.join(process.resourcesPath, "bin", shimName);
		} else {
			const devCliShimName = process.platform === "win32" ? "kanban-dev.cmd" : "kanban-dev";
			kanbanCliCommand = path.join(import.meta.dirname, "..", "build", "bin", devCliShimName);
		}

		connectionManager = new ConnectionManager({
			childManager: runtimeManager,
			store: connectionStore,
			kanbanCliCommand,
			getDialogParent: () => windowRegistry.getFocused(),
			onLoadUrl: async (url: string) => {
				await windowRegistry.loadUrlInAllWindows(url);
			},
			onInstallAuth: async (serverUrl: string, token: string) => {
				await installAuthOnAllWindows(serverUrl, token);
			},
			onRemoveAuth: () => {
				removeAuthFromAllWindows();
			},
			onConnectionChanged: () => {
				rebuildMenu();
			},
		onLocalRuntimeReady: (url, token) => {
			runtimeUrl = url;
			authToken = token;
			if (!terminalOwnsDescriptor) {
				void publishRuntimeDescriptor(url, token);
			}
		},
		onLocalRuntimeStopped: () => {
			if (!terminalOwnsDescriptor) {
				// Only clear if the descriptor still belongs to this desktop session.
				void (async () => {
					try {
						const current = await readRuntimeDescriptor();
						if (
							current &&
							current.source === "desktop" &&
							current.desktopSessionId === desktopSessionId
						) {
							await clearRuntimeDescriptor();
						}
					} catch {
						// Best effort.
					}
				})();
			}
			runtimeUrl = null;
		},
		});

		rebuildMenu();

		// ── initialize-connections ─────────────────────────────────────────
		advanceBootPhase("initialize-connections");

		try {
			await connectionManager.initialize();

			if (!getBootState().failureCode) {
				advanceBootPhase("ready");
				rebuildMenu();
				showInterruptedTasksToast();

				// Watch for CLI descriptor disappearing so desktop can take over.
				if (terminalOwnsDescriptor) {
					startDescriptorWatcher();
				}
			} else {
				rebuildMenu();
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			console.error(`[desktop] Unexpected startup failure: ${message}`);
			recordBootFailure("UNKNOWN_STARTUP_FAILURE", message);
			rebuildMenu();
			dialog.showErrorBox(
				"Kanban Startup Error",
				`Unexpected error:\n\n${message}`,
			);
		}

		// Register power monitor health check.
		setupPowerMonitorHealthCheck();

		// macOS: re-create window when dock icon is clicked and no windows exist.
		app.on("activate", async () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				if (!connectionManager) return;

				advanceBootPhase("create-window");
				createAppWindow({ projectId: null });
				advanceBootPhase("initialize-connections");
				try {
					await connectionManager.reconnectActiveConnection();
					if (!getBootState().failureCode) {
						advanceBootPhase("ready");
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					recordBootFailure("UNKNOWN_STARTUP_FAILURE", message);
				}
			} else {
				// Show the most recent window.
				const focusedWindow = windowRegistry.getFocused();
				if (focusedWindow && !focusedWindow.isVisible()) {
					focusedWindow.show();
				}
			}
		});
	});

	// Quit when all windows are closed (except on macOS).
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") {
			app.quit();
		}
	});

	app.on("before-quit", async (event) => {
		if (isQuitting) return;
		isQuitting = true;

		// Persist all window states.
		windowRegistry.saveAllStates(app.getPath("userData"));

		// Shut down through the connection manager.
		if (connectionManager) {
			event.preventDefault();
			try {
				await connectionManager.shutdown();
			} catch (err) {
				console.error(
					"[desktop] Connection shutdown error:",
					err instanceof Error ? err.message : err,
				);
			} finally {
				stopAppNapPrevention();
				app.quit();
			}
		} else {
			stopAppNapPrevention();
		}
	});

	app.on("will-quit", async () => {
		stopDescriptorWatcher();

		// Only clear the descriptor if it still belongs to THIS desktop session.
		// Another process (CLI) may have overwritten it after we booted.
		if (!terminalOwnsDescriptor) {
			try {
				const current = await readRuntimeDescriptor();
				if (
					current &&
					current.source === "desktop" &&
					current.desktopSessionId === desktopSessionId
				) {
					await clearRuntimeDescriptor();
				}
			} catch {
				// Best effort.
			}
		}

		if (runtimeManager) {
			await runtimeManager.dispose().catch(() => {});
			runtimeManager = null;
		}

		connectionManager = null;
		connectionStore = null;
	});
}
