/**
 * Window state persistence — stores BrowserWindow position, size, and
 * maximized state to userData so windows reopen in the same position.
 *
 * Multi-window format: `window-states.json` (array of PersistedWindowState).
 * A one-time migration converts the legacy `window-state.json` on first read.
 *
 * Intentionally free of Electron imports so pure functions can be unit-tested.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface WindowState {
	x: number | undefined;
	y: number | undefined;
	width: number;
	height: number;
	isMaximized: boolean;
}

export interface PersistedWindowState extends WindowState {
	projectId: string | null;
	lastViewedPath?: string | null;
}

const LEGACY_STATE_FILE = "window-state.json";
const MULTI_STATE_FILE = "window-states.json";

export function resolveWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, LEGACY_STATE_FILE);
}

export function resolveMultiWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, MULTI_STATE_FILE);
}

function parseWindowState(parsed: Record<string, unknown>): WindowState | undefined {
	if (
		typeof parsed.width !== "number" ||
		typeof parsed.height !== "number" ||
		typeof parsed.isMaximized !== "boolean"
	) {
		return undefined;
	}
	return {
		x: typeof parsed.x === "number" ? parsed.x : undefined,
		y: typeof parsed.y === "number" ? parsed.y : undefined,
		width: parsed.width,
		height: parsed.height,
		isMaximized: parsed.isMaximized,
	};
}

/**
 * Whether a string is a sane `lastViewedPath` value to replay on the next
 * launch by setting it as the pathname on the runtime origin.
 *
 * Must be defended at both save-time (so we don't write bad values) and
 * load-time (so existing bad values from older builds auto-heal instead
 * of stranding the user on a 404 "Not Found" screen they can't escape
 * without deleting `window-states.json`).
 *
 * The specific footgun this guards against: `webContents.getURL()` on a
 * window that was flipped to the local disconnected.html fallback returns
 * a `file:///Users/.../disconnected.html` URL whose `.pathname` looks
 * superficially like a normal "/…" pathname, but replaying it against
 * `http://host:port` gets a 404.
 *
 * Rules: the pathname must start with `/`, must not look like an absolute
 * filesystem path (`/Users/`, `/home/`, `/private/`, `/tmp/`, `/var/`,
 * `/C:/`, etc.), and must not have a `.html` extension — the runtime's
 * SPA never exposes `.html` routes to the user.
 */
export function isPersistableRuntimePath(pathname: string): boolean {
	if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
	if (pathname === "/") return false;
	if (pathname.toLowerCase().endsWith(".html")) return false;
	const absFsPrefixes = ["/Users/", "/home/", "/private/", "/tmp/", "/var/", "/opt/", "/Applications/"];
	for (const prefix of absFsPrefixes) {
		if (pathname.startsWith(prefix)) return false;
	}
	// Windows file URLs surface as `/C:/…`, `/D:/…`, etc.
	if (/^\/[A-Za-z]:\//.test(pathname)) return false;
	return true;
}

/**
 * Extracts the pathname from a runtime URL if it's safe to persist or replay.
 *
 * Returns null unless the input is a real http(s) URL whose pathname passes
 * {@link isPersistableRuntimePath}. Used by:
 *   - window-registry's state-save path, to skip disconnected.html / file://
 *     URLs that look valid but 404 when replayed against the runtime origin.
 *   - app-menu's File → New Window handler, to inherit the source window's
 *     path when it's safe to replay.
 */
export function extractPersistablePath(
	currentUrl: string | undefined | null,
): string | null {
	if (!currentUrl) return null;
	try {
		const url = new URL(currentUrl);
		const isHttp = url.protocol === "http:" || url.protocol === "https:";
		if (isHttp && isPersistableRuntimePath(url.pathname)) {
			return url.pathname;
		}
	} catch {
		// Malformed URL — fall through to null.
	}
	return null;
}

function parsePersistedWindowState(raw: Record<string, unknown>): PersistedWindowState | undefined {
	const base = parseWindowState(raw);
	if (!base) return undefined;
	const state: PersistedWindowState = {
		...base,
		projectId: typeof raw.projectId === "string" ? raw.projectId : null,
	};
	if (typeof raw.lastViewedPath === "string" && isPersistableRuntimePath(raw.lastViewedPath)) {
		state.lastViewedPath = raw.lastViewedPath;
	}
	return state;
}


export function migrateWindowStateIfNeeded(userDataPath: string): boolean {
	const legacyPath = resolveWindowStatePath(userDataPath);
	const multiPath = resolveMultiWindowStatePath(userDataPath);
	if (existsSync(multiPath)) return false;
	if (!existsSync(legacyPath)) return false;
	try {
		const raw = readFileSync(legacyPath, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const state = parseWindowState(parsed);
		if (!state) return false;
		const persisted: PersistedWindowState = { ...state, projectId: null };
		writeFileSync(multiPath, JSON.stringify([persisted], null, "\t"), "utf-8");
		return true;
	} catch {
		return false;
	}
}

export function loadAllWindowStates(userDataPath: string): PersistedWindowState[] {
	migrateWindowStateIfNeeded(userDataPath);
	const filePath = resolveMultiWindowStatePath(userDataPath);
	if (!existsSync(filePath)) return [];
	try {
		const raw = readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const results: PersistedWindowState[] = [];
		for (const entry of parsed) {
			if (typeof entry !== "object" || entry === null) continue;
			const state = parsePersistedWindowState(entry as Record<string, unknown>);
			if (state) results.push(state);
		}
		return results;
	} catch {
		return [];
	}
}

export function saveAllWindowStates(userDataPath: string, states: PersistedWindowState[]): void {
	try {
		const filePath = resolveMultiWindowStatePath(userDataPath);
		writeFileSync(filePath, JSON.stringify(states, null, "\t"), "utf-8");
	} catch {
		// Best-effort — don't crash if userData is read-only.
	}
}
