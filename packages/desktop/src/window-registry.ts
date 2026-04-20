import { BrowserWindow, shell } from "electron";

import {
	type PersistedWindowState,
	extractPersistablePath,
	isPersistableRuntimePath,
	loadAllWindowStates,
	saveAllWindowStates,
} from "./window-state.js";

export interface WindowEntry {
	window: BrowserWindow;
	projectId: string | null;
	lastViewedPath: string | null;
}

export interface CreateWindowOptions {
	projectId?: string | null;
	savedState?: PersistedWindowState;
	preloadPath: string;
	isPackaged: boolean;
	backgroundColor?: string;
	runtimeUrl?: string | null;
	onWindowClosed?: (windowId: number) => void;
	onWindowFocused?: (windowId: number) => void;
	hideOnCloseForMac?: boolean;
	isQuitting?: () => boolean;
}

const DEFAULT_WIDTH = 1400;
const DEFAULT_HEIGHT = 900;
const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;
const DEFAULT_BACKGROUND_COLOR = "#1F2428";

export class WindowRegistry {
	private readonly windows = new Map<number, WindowEntry>();
	private lastFocusedId: number | null = null;

	get size(): number {
		return this.windows.size;
	}

	createWindow(options: CreateWindowOptions): BrowserWindow {
		const projectId = options.projectId ?? null;
		const savedState = options.savedState;
		const backgroundColor = options.backgroundColor ?? DEFAULT_BACKGROUND_COLOR;

		const window = new BrowserWindow({
			x: savedState?.x,
			y: savedState?.y,
			width: savedState?.width ?? DEFAULT_WIDTH,
			height: savedState?.height ?? DEFAULT_HEIGHT,
			minWidth: MIN_WIDTH,
			minHeight: MIN_HEIGHT,
			title: "Kanban",
			backgroundColor,
			show: false,
			webPreferences: {
				preload: options.preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: true,
				webSecurity: true,
				devTools: !options.isPackaged,
			},
		});

		if (savedState?.isMaximized) {
			window.maximize();
		}

		const entry: WindowEntry = {
			window,
			projectId,
			lastViewedPath: options.savedState?.lastViewedPath ?? null,
		};
		this.windows.set(window.id, entry);
		this.lastFocusedId = window.id;

		window.once("ready-to-show", () => {
			window.show();
		});

		window.on("focus", () => {
			this.lastFocusedId = window.id;
			options.onWindowFocused?.(window.id);
		});

		const trustedOrigin = options.runtimeUrl ? new URL(options.runtimeUrl).origin : null;
		window.webContents.on("will-navigate", (event: Electron.Event, url: string) => {
			if (trustedOrigin) {
				try {
					if (new URL(url).origin !== trustedOrigin) {
						event.preventDefault();
					}
				} catch {
					event.preventDefault();
				}
			}
		});

		window.webContents.setWindowOpenHandler(({ url }) => {
			shell.openExternal(url);
			return { action: "deny" };
		});

		window.on("close", (event) => {
			if (
				options.hideOnCloseForMac &&
				process.platform === "darwin" &&
				!(options.isQuitting?.() ?? false)
			) {
				if (this.countVisibleWindows() <= 1) {
					event.preventDefault();
					window.hide();
					return;
				}
			}
		});

		window.on("closed", () => {
			this.windows.delete(window.id);
			if (this.lastFocusedId === window.id) {
				this.lastFocusedId = null;
			}
			options.onWindowClosed?.(window.id);
		});

		return window;
	}

	getVisible(): WindowEntry[] {
		return [...this.windows.values()].filter(
			(entry) => !entry.window.isDestroyed() && entry.window.isVisible(),
		);
	}

	countVisibleWindows(): number {
		return this.getVisible().length;
	}

	getFocused(): BrowserWindow | null {
		const focused = BrowserWindow.getFocusedWindow();
		if (focused && this.windows.has(focused.id)) {
			return focused;
		}

		if (this.lastFocusedId !== null) {
			const entry = this.windows.get(this.lastFocusedId);
			if (entry && !entry.window.isDestroyed()) {
				return entry.window;
			}
			this.lastFocusedId = null;
		}

		for (const entry of this.windows.values()) {
			if (!entry.window.isDestroyed()) {
				return entry.window;
			}
		}

		return null;
	}

	saveAllStates(userDataPath: string): void {
		const states: PersistedWindowState[] = [];
		for (const entry of this.windows.values()) {
			if (entry.window.isDestroyed()) continue;
			const isMaximized = entry.window.isMaximized();
			const bounds = isMaximized
				? entry.window.getNormalBounds()
				: entry.window.getBounds();

			// Only persist runtime http(s) pathnames — skip disconnected.html
			// and other non-runtime URLs that would 404 on replay. See
			// extractPersistablePath for the full set of rejection rules.
			const persistable = extractPersistablePath(
				entry.window.webContents.getURL(),
			);
			if (persistable) entry.lastViewedPath = persistable;

			states.push({
				x: bounds.x,
				y: bounds.y,
				width: bounds.width,
				height: bounds.height,
				isMaximized,
				projectId: entry.projectId,
				lastViewedPath: entry.lastViewedPath,
			});
		}
		saveAllWindowStates(userDataPath, states);
	}

	static loadPersistedWindows(userDataPath: string): PersistedWindowState[] {
		return loadAllWindowStates(userDataPath);
	}

	/**
	 * Build the renderer URL for a window opened to a specific project.
	 *
	 * Uses path-based encoding (`/<projectId>`) to match the web-ui's
	 * existing project-routing scheme (parseProjectIdFromPathname). This
	 * keeps the renderer free of any desktop-specific URL handling — the
	 * window simply lands on the project's normal pathname like a regular
	 * tab, and the user is free to navigate anywhere from there.
	 */
	static buildWindowUrl(baseUrl: string, projectId: string | null): string {
		if (!projectId) return baseUrl;
		const url = new URL(baseUrl);
		url.pathname = `/${encodeURIComponent(projectId)}`;
		return url.toString();
	}

	private buildEntryUrl(baseUrl: string, entry: WindowEntry): string {
		// Prefer lastViewedPath so user-navigation is restored on relaunch.
		// projectId is only the *initial* project the window was opened to;
		// the window is not locked to it, so the user may have navigated
		// elsewhere before quitting.
		//
		// Defense in depth: the save-time path already rejects non-http(s)
		// pathnames, but users upgrading from a build that persisted them
		// will still have `/Users/.../disconnected.html` in their state
		// file. Validate here so a one-time-bad state auto-heals on next
		// launch instead of stranding the user on a "Not Found" screen.
		if (entry.lastViewedPath && isPersistableRuntimePath(entry.lastViewedPath)) {
			try {
				const url = new URL(baseUrl);
				url.pathname = entry.lastViewedPath;
				return url.toString();
			} catch {
				// Fall through.
			}
		}
		if (entry.projectId) {
			return WindowRegistry.buildWindowUrl(baseUrl, entry.projectId);
		}
		return baseUrl;
	}

	async loadUrlInAllWindows(baseUrl: string): Promise<void> {
		const promises: Promise<void>[] = [];
		for (const entry of this.windows.values()) {
			if (entry.window.isDestroyed()) continue;
			const url = this.buildEntryUrl(baseUrl, entry);
			promises.push(entry.window.loadURL(url));
		}
		await Promise.all(promises);
	}
}
