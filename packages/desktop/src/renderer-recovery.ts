/**
 * Renderer recovery handlers — attach `did-fail-load` and
 * `render-process-gone` listeners to a BrowserWindow so the user gets a
 * recovery dialog instead of a blank/frozen window after a post-boot failure.
 *
 * Design notes:
 * - No cooldown — `dialog.showMessageBoxSync` is user-gated (modal), so
 *   there is no automatic retry loop.
 * - ERR_ABORTED (code -3) and sub-frame failures are silently ignored.
 * - The connection manager getter is a closure so it picks up the latest
 *   reference (which may be null if preflight failed).
 */

import { type BrowserWindow, dialog } from "electron";
import type { ConnectionManager } from "./connection-manager.js";

/**
 * Attach renderer recovery handlers to the given window.
 *
 * Call this after every `createMainWindow()` — both the initial boot path
 * and the `activate` handler path.
 *
 * @param window             The BrowserWindow to watch.
 * @param getConnectionManager  Closure returning the current ConnectionManager
 *                              (may be null if preflight failed).
 */
export function attachRendererRecoveryHandlers(
	window: BrowserWindow,
	getConnectionManager: () => ConnectionManager | null,
): void {
	window.webContents.on(
		"did-fail-load",
		(
			_event: Electron.Event,
			errorCode: number,
			errorDescription: string,
			_validatedURL: string,
			isMainFrame: boolean,
			_frameProcessId: number,
			_frameRoutingId: number,
		) => {
			// ERR_ABORTED — normal during navigation cancellation.
			if (errorCode === -3) return;
			// Only care about the main frame; sub-resource failures are noise.
			if (!isMainFrame) return;

			console.error(
				`[desktop] Renderer load failed: ${errorDescription} (code ${errorCode})`,
			);

			const choice = dialog.showMessageBoxSync(window, {
				type: "error",
				title: "Page Load Failed",
				message: `The app failed to load:\n\n${errorDescription}`,
				buttons: ["Retry", "Dismiss"],
				defaultId: 0,
			});

			if (choice === 0) {
				getConnectionManager()
					?.reconnectActiveConnection()
					.catch((err: unknown) => {
						console.error(
							"[desktop] Reconnect after load failure failed:",
							err,
						);
					});
			}
		},
	);

	window.webContents.on(
		"render-process-gone",
		(_event: Electron.Event, details: Electron.RenderProcessGoneDetails) => {
			console.error(
				`[desktop] Renderer process gone: reason=${details.reason}, exitCode=${details.exitCode}`,
			);

			const choice = dialog.showMessageBoxSync(window, {
				type: "error",
				title: "Renderer Crashed",
				message: `The renderer process exited unexpectedly (${details.reason}).`,
				buttons: ["Reload", "Dismiss"],
				defaultId: 0,
			});

			if (choice === 0) {
				getConnectionManager()
					?.reconnectActiveConnection()
					.catch((err: unknown) => {
						console.error(
							"[desktop] Reconnect after renderer crash failed:",
							err,
						);
					});
			}
		},
	);
}
