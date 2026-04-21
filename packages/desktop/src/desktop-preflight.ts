/**
 * Desktop preflight validation — checks that critical packaged/dev resources
 * exist before the app gets deep into boot.
 *
 * Run this early in the app.whenReady() boot path so that missing preload
 * scripts, CLI binaries, or CLI shims fail deterministically with
 * actionable messages rather than opaque late-boot crashes.
 */

import { existsSync } from "node:fs";

export interface DesktopPreflightFailure {
	code: "PRELOAD_MISSING" | "CLI_SHIM_MISSING" | "NODE_PTY_UNAVAILABLE";
	message: string;
	details?: Record<string, string | boolean | null>;
}

export interface DesktopPreflightOptions {
	/** Absolute path to preload.js. */
	preloadPath: string;
	/**
	 * Path to the Kanban CLI shim script that the runtime manager will spawn.
	 * In our packaging, this is `Resources/bin/kanban{,.cmd}` — a shell
	 * script that lives OUTSIDE the asar bundle and execs node against the
	 * asar-unpacked `cli/cli.js`. Preflight only needs to verify that this
	 * entry point exists; the shim itself validates the interior binary.
	 */
	cliShimPath: string;
	isPackaged: boolean;
	/** When true, attempt to verify that node-pty can be loaded. Defaults to false. */
	checkNodePty?: boolean;
}

export interface DesktopPreflightResult {
	/**
	 * `true` iff there are no `failures` (warnings do not affect `ok`).
	 * Callers that want to surface warnings separately should iterate
	 * `warnings` explicitly.
	 */
	ok: boolean;
	/** Hard failures — the app cannot boot correctly without fixing these. */
	failures: DesktopPreflightFailure[];
	/** Soft failures — the app will boot but some features may be degraded. */
	warnings: DesktopPreflightFailure[];
	resources: {
		preloadExists: boolean;
		cliShimExists: boolean;
		nodePtyLoadable: boolean | null;
	};
}

// This module is compiled to CommonJS (see tsconfig.build.json), so the
// `require` global below is available at runtime. If the compile target
// is ever flipped to ESM, switch to `createRequire(import.meta.url)`.
declare const require: NodeJS.Require;

export function runDesktopPreflight(
	opts: DesktopPreflightOptions,
): DesktopPreflightResult {
	const failures: DesktopPreflightFailure[] = [];
	const warnings: DesktopPreflightFailure[] = [];

	// 1. Preload script
	const preloadExists = existsSync(opts.preloadPath);
	if (!preloadExists) {
		failures.push({
			code: "PRELOAD_MISSING",
			message: `Preload script not found at: ${opts.preloadPath}`,
			details: { path: opts.preloadPath, isPackaged: opts.isPackaged },
		});
	}

	// 2. CLI shim — the spawn entry point (RuntimeChildManager invokes this).
	const cliShimExists = existsSync(opts.cliShimPath);
	if (!cliShimExists) {
		failures.push({
			code: "CLI_SHIM_MISSING",
			message: `CLI shim not found at: ${opts.cliShimPath}`,
			details: { path: opts.cliShimPath, isPackaged: opts.isPackaged },
		});
	}

	// 3. node-pty (optional, warning only). Actually `require()` the module
	//    rather than `require.resolve()` — we specifically want to verify
	//    the native binding loads against the current Electron ABI, not just
	//    that the package exists on disk.
	let nodePtyLoadable: boolean | null = null;
	if (opts.checkNodePty) {
		try {
			require("node-pty");
			nodePtyLoadable = true;
		} catch (err) {
			nodePtyLoadable = false;
			warnings.push({
				code: "NODE_PTY_UNAVAILABLE",
				message: "node-pty could not be loaded. Terminal features may be unavailable.",
				details: {
					error: err instanceof Error ? err.message : String(err),
				},
			});
		}
	}

	return {
		ok: failures.length === 0,
		failures,
		warnings,
		resources: {
			preloadExists,
			cliShimExists,
			nodePtyLoadable,
		},
	};
}
