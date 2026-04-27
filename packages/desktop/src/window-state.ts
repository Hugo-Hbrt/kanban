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

export function resolveMultiWindowStatePath(userDataPath: string): string {
	return path.join(userDataPath, "window-states.json");
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
 * A crashed runtime leaves windows on `file:///…/disconnected.html`, whose
 * `.pathname` looks replayable but 404s against `http://host:port`. Reject
 * filesystem-looking paths and `.html` routes at both save- and load-time
 * so older bad state auto-heals.
 */
export function isPersistableRuntimePath(pathname: string): boolean {
	if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
	if (pathname === "/") return false;
	if (pathname.toLowerCase().endsWith(".html")) return false;
	// Heuristic guard against filesystem-looking paths leaking in via
	// hand-edited or corrupted state files. Not exhaustive; the `.html`
	// check above catches the realistic crash-page case.
	const absFsPrefixes = ["/Users/", "/home/", "/private/", "/tmp/", "/var/", "/opt/", "/Applications/"];
	for (const prefix of absFsPrefixes) {
		if (pathname.startsWith(prefix)) return false;
	}
	return true;
}

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
		/* malformed URL */
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

export function loadAllWindowStates(userDataPath: string): PersistedWindowState[] {
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
	} catch (err) {
		// A corrupt state file would otherwise silently lose every saved
		// window — log so support can spot it.
		console.warn(
			"[desktop] Failed to read window states from",
			filePath,
			"—",
			err instanceof Error ? err.message : err,
		);
		return [];
	}
}

export function saveAllWindowStates(userDataPath: string, states: PersistedWindowState[]): void {
	try {
		const filePath = resolveMultiWindowStatePath(userDataPath);
		writeFileSync(filePath, JSON.stringify(states, null, "\t"), "utf-8");
	} catch (err) {
		console.warn(
			"[desktop] Failed to save window states:",
			err instanceof Error ? err.message : err,
		);
	}
}
