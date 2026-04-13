/**
 * Preload script for the Electron renderer process.
 *
 * Runs in a sandboxed context with access to a limited set of Node APIs.
 * Uses contextBridge to safely expose IPC channels to the renderer.
 */

import { contextBridge, ipcRenderer } from "electron";

/**
 * Desktop API exposed to the renderer via window.desktop.
 * Kept minimal; only add methods here when the renderer genuinely needs
 * main-process capabilities that can't go through the runtime HTTP/WS layer.
 */
const desktopApi = {
	/** Returns the platform the desktop app is running on. */
	platform: process.platform,

	/**
	 * Open a new Electron window locked to the given project.
	 */
	openProjectWindow(projectId: string): void {
		ipcRenderer.send("open-project-window", projectId);
	},

	/**
	 * Persist a key/value setting to a file-backed store that survives
	 * origin/port changes across restarts.
	 */
	setDesktopSetting(key: string, value: string): void {
		ipcRenderer.send("set-desktop-setting", key, value);
	},

	/**
	 * Read a persisted setting. Returns null if the key has never been set.
	 */
	getDesktopSetting(key: string): Promise<string | null> {
		return ipcRenderer.invoke("get-desktop-setting", key);
	},

} as const;

contextBridge.exposeInMainWorld("desktop", desktopApi);

export type DesktopApi = typeof desktopApi;
