#!/usr/bin/env node

/**
 * Electron launch helper — strips ELECTRON_RUN_AS_NODE before spawning
 * to ensure the main process can import from "electron".
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");

// Resolve the Electron binary from the local node_modules.
const require = createRequire(import.meta.url);
const electronPath = require("electron");

// Build a sanitised environment — delete the flag that would force
// Electron into "run-as-node" mode.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

// Forward any extra CLI arguments (e.g. --inspect).
const extraArgs = process.argv.slice(2);

const child = spawn(electronPath, [resolve(desktopRoot, "dist", "main.js"), ...extraArgs], {
	stdio: "inherit",
	env,
	cwd: desktopRoot,
});

// Surface spawn-time failures (missing binary, EACCES on the Electron
// helper, etc.) instead of letting them manifest as a silent no-output
// exit. Without this handler, a failed spawn emits only the 'error'
// event and never calls the 'close' handler above, so the process would
// exit 0 without a clue as to what went wrong.
child.on("error", (err) => {
	console.error(
		`Failed to launch Electron at ${electronPath}:`,
		err instanceof Error ? err.message : err,
	);
	process.exit(1);
});

child.on("close", (code, signal) => {
	if (code !== null) {
		process.exit(code);
	}
	if (signal) {
		console.error(`Electron exited with signal ${signal}`);
		process.exit(1);
	}
});

// Relay termination signals to the child.
for (const sig of ["SIGINT", "SIGTERM"]) {
	process.on(sig, () => {
		if (!child.killed) {
			child.kill(sig);
		}
	});
}
