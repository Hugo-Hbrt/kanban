/**
 * Application menu builder.
 *
 * The menu reflects runtime state (edit/navigation entries are greyed out
 * until a URL is loaded) and the list of open windows (checkboxes focus
 * back to each one). Rebuild on: window created/closed/focused, runtime
 * URL change.
 */

import { Menu, app, shell } from "electron";

import type { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import type { WindowRegistry } from "./window-registry.js";
import { extractPersistablePath } from "./window-state.js";

export interface AppMenuOptions {
	registry: WindowRegistry;
	orchestrator: RuntimeOrchestrator;
	/**
	 * Triggered by File → New Window. If there's a focused window with a
	 * non-root pathname, it's passed in so the new window can open at the
	 * same route.
	 */
	onNewWindow: (options: { initialPath: string | null }) => void;
}

export class AppMenu {
	constructor(private readonly opts: AppMenuOptions) {}

	rebuild(): void {
		Menu.setApplicationMenu(Menu.buildFromTemplate(this.buildTemplate()));
	}

	private buildTemplate(): Electron.MenuItemConstructorOptions[] {
		const isMac = process.platform === "darwin";
		const ready = this.opts.orchestrator.getUrl() !== null;

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
					click: () => this.handleNewWindow(),
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
			],
		};

		const template: Electron.MenuItemConstructorOptions[] = [];
		if (isMac) template.push(appMenu);
		template.push(fileMenu, editMenu, viewMenu, this.buildWindowMenu(isMac), helpMenu);
		return template;
	}

	private buildWindowMenu(isMac: boolean): Electron.MenuItemConstructorOptions {
		const windowEntries = this.opts.registry.getVisible();
		const focused = this.opts.registry.getFocused();
		const windowListItems: Electron.MenuItemConstructorOptions[] =
			windowEntries.map((entry) => {
				const title = entry.window.isDestroyed()
					? "Kanban"
					: entry.window.getTitle() || "Kanban";
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

		return {
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
	}

	private handleNewWindow(): void {
		const focused = this.opts.registry.getFocused();
		const currentUrl =
			focused && !focused.isDestroyed()
				? focused.webContents.getURL()
				: null;
		this.opts.onNewWindow({ initialPath: extractPersistablePath(currentUrl) });
	}
}
