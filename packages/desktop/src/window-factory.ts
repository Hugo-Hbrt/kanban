/**
 * Window factory — creates project-scoped BrowserWindows and handles
 * renderer-side failure recovery.
 *
 * The factory:
 *   • Delegates raw BrowserWindow construction to {@link WindowRegistry}
 *     (which also persists window state and tracks focus).
 *   • Loads the correct runtime URL based on caller-supplied projectId /
 *     initialPath.
 *   • Attaches `did-fail-load` and `render-process-gone` listeners that
 *     distinguish "renderer glitch" (retry) from "runtime died" (flip all
 *     windows to the disconnected screen).
 *   • Exposes {@link showDisconnectedScreen} for the shell to call on
 *     runtime crash events from the orchestrator.
 */

import { BrowserWindow, dialog } from "electron";

import type { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { WindowRegistry } from "./window-registry.js";
import {
	type PersistedWindowState,
	isPersistableRuntimePath,
} from "./window-state.js";

export interface WindowFactoryOptions {
	preloadPath: string;
	isPackaged: boolean;
	backgroundColor: string;
	/** Path to disconnected.html (copied to dist/ at build time). */
	disconnectedHtmlPath: string;
	registry: WindowRegistry;
	orchestrator: RuntimeOrchestrator;
	/** Live signal for `before-quit` — lets the registry skip hide-on-close. */
	isQuitting: () => boolean;
	/** Invoked when menu state may have changed (window created/closed/focused). */
	onMenuDirty: () => void;
}

export interface CreateWindowOptions {
	projectId?: string | null;
	initialPath?: string | null;
	savedState?: PersistedWindowState;
}

export class WindowFactory {
	constructor(private readonly opts: WindowFactoryOptions) {}

	create(options: CreateWindowOptions = {}): BrowserWindow {
		const window = this.opts.registry.createWindow({
			projectId: options.projectId ?? null,
			savedState: options.savedState,
			preloadPath: this.opts.preloadPath,
			isPackaged: this.opts.isPackaged,
			backgroundColor: this.opts.backgroundColor,
			runtimeUrl: this.opts.orchestrator.getUrl() ?? undefined,
			hideOnCloseForMac: true,
			isQuitting: this.opts.isQuitting,
			onWindowClosed: this.opts.onMenuDirty,
			onWindowFocused: this.opts.onMenuDirty,
		});

		this.attachRendererRecovery(window);

		const runtimeUrl = this.opts.orchestrator.getUrl();
		if (runtimeUrl) {
			const url = buildWindowUrl(runtimeUrl, options);
			window.loadURL(url).catch((err: unknown) => {
				console.error(
					"[desktop] Failed to load URL in window:",
					err instanceof Error ? err.message : err,
				);
			});
		}

		this.opts.onMenuDirty();
		return window;
	}

	/**
	 * Loads the disconnected fallback page into every live window. Called
	 * on runtime crash and on a persistent "runtime unreachable" classification
	 * from {@link attachRendererRecovery}.
	 */
	showDisconnectedScreen(): void {
		for (const win of BrowserWindow.getAllWindows()) {
			if (win.isDestroyed()) continue;
			win.loadFile(this.opts.disconnectedHtmlPath).catch(() => {});
		}
		this.opts.onMenuDirty();
	}

	private attachRendererRecovery(window: BrowserWindow): void {
		// Distinguish renderer-local failures (retryable) from runtime
		// unreachability (disconnected screen). Probe the runtime origin
		// via checkHealth() before deciding how to recover.
		window.webContents.on(
			"did-fail-load",
			(_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
				// -3 (ERR_ABORTED) is emitted for user-initiated navigations
				// and in-flight loads cancelled by a subsequent loadURL — not
				// an actual failure.
				if (errorCode === -3 || !isMainFrame) return;
				console.error(
					`[desktop] Renderer load failed: ${errorDescription} (code ${errorCode})`,
				);

				const origin =
					this.opts.orchestrator.getUrl() ??
					this.opts.orchestrator.defaultOrigin();
				void this.opts.orchestrator.checkHealth(origin).then((healthy) => {
					if (window.isDestroyed()) return;

					if (!healthy) {
						this.showDisconnectedScreen();
						return;
					}

					const choice = dialog.showMessageBoxSync(window, {
						type: "error",
						title: "Page Load Failed",
						message: `The app failed to load:\n\n${errorDescription}`,
						buttons: ["Retry", "Dismiss"],
						defaultId: 0,
					});
					const runtimeUrl = this.opts.orchestrator.getUrl();
					if (choice === 0 && runtimeUrl) {
						window.loadURL(runtimeUrl).catch(() => {});
					}
				});
			},
		);

		window.webContents.on("render-process-gone", (_event, details) => {
			console.error(`[desktop] Renderer process gone: reason=${details.reason}`);
			if (window.isDestroyed()) return;

			const origin =
				this.opts.orchestrator.getUrl() ??
				this.opts.orchestrator.defaultOrigin();
			void this.opts.orchestrator.checkHealth(origin).then((healthy) => {
				if (window.isDestroyed()) return;
				const runtimeUrl = this.opts.orchestrator.getUrl();
				if (healthy && runtimeUrl) {
					window.loadURL(runtimeUrl).catch(() => {});
				} else {
					this.showDisconnectedScreen();
				}
			});
		});
	}
}

/**
 * Accept only within-app paths: single leading slash, no scheme, no
 * protocol-relative authority. `initialPath` can originate from untrusted
 * deep links (`kanban://…?path=…`), so even though `URL.pathname` would
 * normalise the origin back to the runtime, we reject obviously-crafted
 * values up front rather than hand them to the in-page router.
 */
function isSafeInitialPath(p: string): boolean {
	if (!p.startsWith("/")) return false;
	// `//foo` would be parsed by URL as protocol-relative; reject to avoid
	// surprises in downstream consumers that concatenate paths without
	// going through URL parsing.
	if (p.startsWith("//")) return false;
	// `scheme:…` — reject anything that looks like a URL with a scheme.
	if (/^\/[a-z][a-z0-9+\-.]*:/i.test(p)) return false;
	return true;
}

function buildWindowUrl(
	runtimeUrl: string,
	options: CreateWindowOptions,
): string {
	if (options.projectId) {
		return WindowRegistry.buildWindowUrl(runtimeUrl, options.projectId);
	}
	if (options.initialPath) {
		// Two-layer defence: `isSafeInitialPath` rejects malformed or
		// scheme-ish values (`//foo`, `/file:/…`) that could escape the
		// runtime origin; `isPersistableRuntimePath` rejects values that
		// would resolve to 404 against the runtime (filesystem-looking
		// paths, `.html` routes). This matches the guard in
		// `window-registry.buildEntryUrl` so any future caller passing an
		// untrusted path gets the same treatment.
		if (
			!isSafeInitialPath(options.initialPath) ||
			!isPersistableRuntimePath(options.initialPath)
		) {
			console.warn(
				`[desktop] Ignoring unsafe initialPath: ${options.initialPath}`,
			);
			return runtimeUrl;
		}
		const parsed = new URL(runtimeUrl);
		parsed.pathname = options.initialPath;
		return parsed.toString();
	}
	return runtimeUrl;
}
