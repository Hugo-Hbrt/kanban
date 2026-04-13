/**
 * Pure utility functions for connection management.
 * No Electron imports — safe to test in a plain Node.js environment.
 */

/**
 * Returns true if the URL is plain HTTP targeting a non-localhost host.
 * Used to warn users about insecure connections.
 */
export function isInsecureRemoteUrl(serverUrl: string): boolean {
	try {
		const url = new URL(serverUrl);
		if (url.protocol !== "http:") return false;
		const host = url.hostname.toLowerCase();
		const localhosts = ["localhost", "127.0.0.1", "::1", "[::1]"];
		return !localhosts.includes(host);
	} catch {
		return false;
	}
}
