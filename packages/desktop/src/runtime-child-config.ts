/**
 * Configuration for the Kanban runtime subprocess.
 *
 * ⚠️  Keep this file intentionally minimal — only pure type definitions
 * and zero runtime code.
 */

// ---------------------------------------------------------------------------
// Runtime configuration passed to the CLI subprocess via flags/env
// ---------------------------------------------------------------------------

export interface RuntimeChildConfig {
	/** Host for the runtime HTTP server to bind to. */
	host: string;
	/** Port for the runtime HTTP server. */
	port: number;
}
