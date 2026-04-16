/**
 * Electron main process entry point — thin shell model.
 *
 * Flow:
 *   1. On launch: health-check the default port (3484).
 *      If a runtime is already running → load its URL in the window.
 *   2. If nothing's running: start a runtime child process (the Kanban CLI),
 *      poll until the server is reachable, then load the URL.
 *   3. On runtime death: show the disconnected screen.  The user can
 *      click "Restart" to manually re-launch the child.  There is no
 *      hidden auto-restart; recovery is always user-initiated.
 *   4. Multi-window: each new window is another BrowserWindow pointing
 *      at the same runtime URL. The server handles multiple clients.
 */

import {
	BrowserWindow,
	Menu,
	app,
	dialog,
	ipcMain,
	powerSaveBlocker,
	shell,
} from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";

import { runDesktopPreflight, type DesktopPreflightResult } from "./desktop-preflight.js";
import {
	extractProtocolUrlFromArgv,
	parseProtocolUrl,
	registerProtocol,
} from "./protocol-handler.js";
import { relayOAuthCallback } from "./oauth-relay.js";
import { RuntimeChildManager } from "./runtime-child.js";
import { WindowRegistry } from "./window-registry.js";
import type { PersistedWindowState } from "./window-state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BACKGROUND_COLOR = "#1F2428";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3484;

/** Health check timeout (ms). */
const HEALTH_TIMEOUT_MS = 3_000;

/** Path to the disconnected HTML page. */
const DISCONNECTED_HTML_PATH = path.join(import.meta.dirname, "disconnected.html");

// ---------------------------------------------------------------------------
// Main process state
// ---------------------------------------------------------------------------

const windowRegistry = new WindowRegistry();

let runtimeManager: RuntimeChildManager | null = null;
let runtimeUrl: string | null = null;

/** Whether we started the child or attached to an existing runtime. */
let ownsChild = false;

/** Preflight result — stored for diagnostics. */
let preflightResult: DesktopPreflightResult | null = null;

/** Power save blocker ID (-1 if inactive). */
let powerSaveBlockerId = -1;

/** Whether `before-quit` has been signalled. */
let isQuitting = false;

/** In-flight restart promise for deduplication. */
let restartPromise: Promise<void> | null = null;

app.commandLine.appendSwitch("disable-renderer-backgrounding");

// ---------------------------------------------------------------------------
// Preload path
// ---------------------------------------------------------------------------

const preloadPath = path.join(import.meta.dirname, "preload.js");

// ---------------------------------------------------------------------------
// kanban:// protocol registration
// ---------------------------------------------------------------------------

registerProtocol(app);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function checkHealth(origin: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
		const res = await fetch(`${origin}/api/health`, {
			signal: controller.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------

function createAppWindow(options: {
	projectId?: string | null;
	initialPath?: string | null;
	savedState?: PersistedWindowState;
}): BrowserWindow {
	const window = windowRegistry.createWindow({
		projectId: options.projectId ?? null,
		savedState: options.savedState,
		preloadPath,
		isPackaged: app.isPackaged,
		backgroundColor: BACKGROUND_COLOR,
		runtimeUrl: runtimeUrl ?? undefined,
		hideOnCloseForMac: true,
		isQuitting: () => isQuitting,
		onWindowClosed: () => rebuildMenu(),
		onWindowFocused: () => rebuildMenu(),
	});

	// Renderer recovery — health-check before reload.
	attachRendererRecovery(window);

	// If the runtime is already running, load the URL in this window.
	if (runtimeUrl) {
		let url: string;
		if (options.projectId) {
			url = WindowRegistry.buildWindowUrl(runtimeUrl, options.projectId);
		} else if (options.initialPath) {
			const parsed = new URL(runtimeUrl);
			parsed.pathname = options.initialPath;
			url = parsed.toString();
		} else {
			url = runtimeUrl;
		}
		window.loadURL(url).catch((err: unknown) => {
			console.error(
				"[desktop] Failed to load URL in window:",
				err instanceof Error ? err.message : err,
			);
		});
	}

	rebuildMenu();
	return window;
}

// ---------------------------------------------------------------------------
// Renderer recovery — health-first
// ---------------------------------------------------------------------------

function attachRendererRecovery(window: BrowserWindow): void {
	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
			if (errorCode === -3 || !isMainFrame) return;
			console.error(`[desktop] Renderer load failed: ${errorDescription} (code ${errorCode})`);

			const origin = runtimeUrl ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
			void checkHealth(origin).then((healthy) => {
				if (window.isDestroyed()) return;

				if (!healthy) {
					runtimeUrl = null;
					showDisconnectedScreen();
					return;
				}

				const choice = dialog.showMessageBoxSync(window, {
					type: "error",
					title: "Page Load Failed",
					message: `The app failed to load:\n\n${errorDescription}`,
					buttons: ["Retry", "Dismiss"],
					defaultId: 0,
				});
				if (choice === 0 && runtimeUrl) {
					window.loadURL(runtimeUrl).catch(() => {});
				}
			});
		},
	);

	window.webContents.on("render-process-gone", (_event, details) => {
		console.error(`[desktop] Renderer process gone: reason=${details.reason}`);

		if (window.isDestroyed()) return;

		const origin = runtimeUrl ?? `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
		void checkHealth(origin).then((healthy) => {
			if (window.isDestroyed()) return;
			if (healthy && runtimeUrl) {
				window.loadURL(runtimeUrl).catch(() => {});
			} else {
				runtimeUrl = null;
				showDisconnectedScreen();
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Protocol URL handling (OAuth deep-links)
// ---------------------------------------------------------------------------

function handleProtocolUrl(raw: string): void {
	const parsed = parseProtocolUrl(raw);
	if (!parsed?.isOAuthCallback || !runtimeUrl) return;

	const relayTarget = new URL("/kanban-mcp/mcp-oauth-callback", runtimeUrl);
	for (const [key, value] of parsed.searchParams.entries()) {
		relayTarget.searchParams.set(key, value);
	}

	const focusedWindow = windowRegistry.getFocused();
	relayOAuthCallback(relayTarget.toString(), null, {
		fetch: globalThis.fetch,
		getMainWindow: () => focusedWindow,
	}).catch((err) => console.error("[desktop] OAuth relay error:", err));

	if (focusedWindow && !focusedWindow.isDestroyed()) {
		if (focusedWindow.isMinimized()) focusedWindow.restore();
		focusedWindow.show();
		focusedWindow.focus();
	}
}

app.on("open-url", (event, url) => {
	event.preventDefault();
	handleProtocolUrl(url);
});

// ---------------------------------------------------------------------------
// E2E state isolation
// ---------------------------------------------------------------------------

if (process.env.KANBAN_DESKTOP_USER_DATA) {
	app.setPath("userData", process.env.KANBAN_DESKTOP_USER_DATA);
}

// ---------------------------------------------------------------------------
// Second instance / --project parsing
// ---------------------------------------------------------------------------

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
		const protocolUrl = extractProtocolUrlFromArgv(argv);
		if (protocolUrl) handleProtocolUrl(protocolUrl);

		const projectId = parseProjectFromArgv(argv);
		if (projectId) {
			createAppWindow({ projectId });
			return;
		}

		const focused = windowRegistry.getFocused();
		if (focused) {
			if (focused.isMinimized()) focused.restore();
			focused.focus();
		}
	});
}

// ---------------------------------------------------------------------------
// Disconnected screen — shown when runtime is unreachable
// ---------------------------------------------------------------------------

function showDisconnectedScreen(): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (win.isDestroyed()) continue;
		win.loadFile(DISCONNECTED_HTML_PATH).catch(() => {});
	}
	rebuildMenu();
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
// IPC: restart-runtime (renderer → main, from disconnected screen)
// ---------------------------------------------------------------------------

ipcMain.on("restart-runtime", () => {
	console.log("[desktop] Restart requested from renderer.");
	void restartRuntime();
});

// ---------------------------------------------------------------------------
// Runtime child lifecycle
// ---------------------------------------------------------------------------

function createRuntimeChildManager(): RuntimeChildManager {
	const manager = new RuntimeChildManager({
		cliPath: resolveCliShimPath(),
		shutdownTimeoutMs: 5_000,
	});

	manager.on("crashed", (exitCode, signal, stderrTail) => {
		console.error(
			`[desktop] Runtime crashed (code=${exitCode}, signal=${signal})`,
		);
		if (stderrTail.trim().length > 0) {
			// The tail is capped at ~8 KB by RuntimeChildManager; safe to
			// log in one go. This is invaluable for diagnosing a CLI that
			// died before becoming reachable (the most common class of
			// desktop-only packaging failure).
			console.error("[desktop] Runtime stderr tail:\n" + stderrTail);
		}
		runtimeUrl = null;
		showDisconnectedScreen();
	});

	manager.on("error", (message: string) => {
		console.error(`[desktop] Runtime error: ${message}`);
	});

	return manager;
}

function resolveCliShimPath(): string {
	if (app.isPackaged) {
		const shimName = process.platform === "win32" ? "kanban.cmd" : "kanban";
		return path.join(process.resourcesPath, "bin", shimName);
	}
	const devShimName = process.platform === "win32" ? "kanban-dev.cmd" : "kanban-dev";
	return path.join(import.meta.dirname, "..", "build", "bin", devShimName);
}

async function startOwnRuntime(): Promise<void> {
	if (!runtimeManager) {
		runtimeManager = createRuntimeChildManager();
	}

	const url = await runtimeManager.start({
		host: DEFAULT_HOST,
		port: DEFAULT_PORT,
	});

	runtimeUrl = url;
	ownsChild = true;
}

async function restartRuntime(): Promise<void> {
	if (restartPromise) {
		await restartPromise;
		return;
	}

	restartPromise = (async () => {
		try {
			if (runtimeManager) {
				await runtimeManager.shutdown().catch(() => {});
				runtimeManager = null;
			}
			await startOwnRuntime();
			void windowRegistry.loadUrlInAllWindows(runtimeUrl!);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			console.error(`[desktop] Failed to restart runtime: ${msg}`);
			dialog.showErrorBox("Kanban Startup Error", `Failed to start runtime:\n\n${msg}`);
		}
	})().finally(() => {
		restartPromise = null;
	});

	await restartPromise;
}

// ---------------------------------------------------------------------------
// Application menu
// ---------------------------------------------------------------------------

function buildMenuTemplate(): Electron.MenuItemConstructorOptions[] {
	const isMac = process.platform === "darwin";
	const ready = !!runtimeUrl;

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
					const focused = windowRegistry.getFocused();
					let initialPath: string | null = null;
					if (focused && !focused.isDestroyed()) {
						try {
							const url = new URL(focused.webContents.getURL());
							if (url.pathname && url.pathname !== "/") {
								initialPath = url.pathname;
							}
						} catch { /* best effort */ }
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
			{ role: "undo", enabled: ready },
			{ role: "redo", enabled: ready },
			{ type: "separator" },
			{ role: "cut", enabled: ready },
			{ role: "copy", enabled: ready },
			{ role: "paste", enabled: ready },
			{ role: "selectAll", enabled: ready },
		],
	};

	const viewMenu: Electron.MenuItemConstructorOptions = {
		label: "View",
		submenu: [
			{ role: "reload", enabled: ready },
			...(!app.isPackaged
				? ([
						{ role: "forceReload", enabled: ready },
						{ role: "toggleDevTools" },
					] as Electron.MenuItemConstructorOptions[])
				: []),
			{ type: "separator" },
			{ role: "resetZoom", enabled: ready },
			{ role: "zoomIn", enabled: ready },
			{ role: "zoomOut", enabled: ready },
			{ type: "separator" },
			{ role: "togglefullscreen" },
		],
	};

	const windowEntries = windowRegistry.getVisible();
	const windowListItems: Electron.MenuItemConstructorOptions[] = windowEntries.map((entry) => {
		const title = entry.window.isDestroyed() ? "Kanban" : entry.window.getTitle() || "Kanban";
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
	});

	const windowMenu: Electron.MenuItemConstructorOptions = {
		label: "Window",
		submenu: [
			{ role: "minimize" },
			{ role: "zoom" },
			...(windowListItems.length > 0
				? [{ type: "separator" } as Electron.MenuItemConstructorOptions, ...windowListItems]
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
			{ label: "Kanban Documentation", click: () => shell.openExternal("https://github.com/cline/kanban") },
			{ label: "Report Issue", click: () => shell.openExternal("https://github.com/cline/kanban/issues") },
		],
	};

	const template: Electron.MenuItemConstructorOptions[] = [];
	if (isMac) template.push(appMenu);
	template.push(fileMenu, editMenu, viewMenu, windowMenu, helpMenu);
	return template;
}

function rebuildMenu(): void {
	Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));
}

// ---------------------------------------------------------------------------
// App Nap / suspend prevention
// ---------------------------------------------------------------------------

function startAppNapPrevention(): void {
	if (powerSaveBlockerId !== -1) return;
	powerSaveBlockerId = powerSaveBlocker.start("prevent-app-suspension");
}

function stopAppNapPrevention(): void {
	if (powerSaveBlockerId === -1) return;
	powerSaveBlocker.stop(powerSaveBlockerId);
	powerSaveBlockerId = -1;
}

// ---------------------------------------------------------------------------
// Application lifecycle
// ---------------------------------------------------------------------------

if (gotTheLock) {
	app.whenReady().then(async () => {
		await mkdir(app.getPath("userData"), { recursive: true }).catch(() => {});

		// ── Preflight ─────────────────────────────────────────────────
		const cliShimPath = resolveCliShimPath();

		preflightResult = runDesktopPreflight({
			preloadPath,
			cliBinaryPath: cliShimPath,
			cliShimPath,
			isPackaged: app.isPackaged,
		});

		if (!preflightResult.ok) {
			const details = preflightResult.failures.map((f) => `[${f.code}] ${f.message}`).join("\n\n");
			dialog.showErrorBox("Kanban Startup Error", `Startup preflight failed:\n\n${details}`);
			return;
		}

		// Preflight warnings are non-fatal but worth surfacing so that a
		// user reporting "terminals don't work" has a breadcrumb in logs.
		for (const warning of preflightResult.warnings) {
			console.warn(`[desktop] Preflight warning [${warning.code}]: ${warning.message}`);
		}

		// ── Create windows ────────────────────────────────────────────
		const persistedStates = WindowRegistry.loadPersistedWindows(app.getPath("userData"));

		if (persistedStates.length > 0) {
			for (const savedState of persistedStates) {
				createAppWindow({ projectId: savedState.projectId, savedState });
			}
		} else {
			createAppWindow({ projectId: null });
		}

		rebuildMenu();
		startAppNapPrevention();

		// ── Connect to runtime ────────────────────────────────────────
		const defaultOrigin = `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;
		const existingRuntime = await checkHealth(defaultOrigin);

		if (existingRuntime) {
			console.log(`[desktop] Found existing runtime at ${defaultOrigin}`);
			runtimeUrl = defaultOrigin;
			ownsChild = false;
			await windowRegistry.loadUrlInAllWindows(runtimeUrl);
		} else {
			console.log("[desktop] No runtime found — starting child process.");
			try {
				await startOwnRuntime();
				await windowRegistry.loadUrlInAllWindows(runtimeUrl!);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				console.error(`[desktop] Failed to start runtime: ${msg}`);
				dialog.showErrorBox("Kanban Startup Error", `Failed to start the runtime:\n\n${msg}`);
			}
		}

		rebuildMenu();

		// macOS: re-create window when dock icon clicked and no windows exist.
		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) {
				createAppWindow({ projectId: null });
			} else {
				const focused = windowRegistry.getFocused();
				if (focused && !focused.isVisible()) focused.show();
			}
		});
	});

	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});

	app.on("before-quit", async (event) => {
		if (isQuitting) return;
		isQuitting = true;

		windowRegistry.saveAllStates(app.getPath("userData"));

		if (runtimeManager && ownsChild) {
			event.preventDefault();
			try {
				await runtimeManager.shutdown();
			} catch (err) {
				console.error("[desktop] Runtime shutdown error:", err instanceof Error ? err.message : err);
			} finally {
				stopAppNapPrevention();
				app.quit();
			}
		} else {
			stopAppNapPrevention();
		}
	});

	app.on("will-quit", async () => {
		if (runtimeManager) {
			await runtimeManager.dispose().catch(() => {});
			runtimeManager = null;
		}
	});
}
