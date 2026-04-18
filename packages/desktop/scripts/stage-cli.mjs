#!/usr/bin/env node
/**
 * Stages the runtime + web-ui bundle from the repo root's `dist/` into
 * `packages/desktop/cli/`, where `electron-builder` picks it up via the
 * `cli/**` glob in `electron-builder.yml`.
 *
 * Why this is a script instead of a one-liner in package.json:
 *
 * The desktop's `build:mac:*` scripts only run `stage:cli + build:ts +
 * electron-builder`. They do NOT build the runtime CLI or the web UI —
 * those are produced by the **root** `npm run build` (which does
 * `web:build` + `node scripts/build.mjs` + copies `web-ui/dist/*` into
 * `dist/web-ui/`). If you forget that prerequisite, the previous
 * one-line `stage:cli` (`shx cp -r ../../dist cli`) silently copies an
 * incomplete `dist/` and the resulting DMG launches successfully but
 * the runtime child immediately crashes with "Could not find web UI
 * assets" — visible only by launching the app from a terminal.
 *
 * This script makes that mistake fail loudly at build time instead.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(here, "..");
const repoRoot = resolve(desktopRoot, "../..");
const distDir = resolve(repoRoot, "dist");
const webUiIndex = resolve(distDir, "web-ui/index.html");
const cliEntry = resolve(distDir, "cli.js");
const stageDir = resolve(desktopRoot, "cli");

function fail(message) {
	console.error(`\n[stage:cli] ERROR: ${message}\n`);
	console.error("[stage:cli] Run the root build first:");
	console.error("[stage:cli]   (cd ../.. && npm run build)\n");
	process.exit(1);
}

if (!existsSync(distDir)) {
	fail(`${distDir} does not exist.`);
}
if (!existsSync(cliEntry)) {
	fail(`${cliEntry} is missing.`);
}
if (!existsSync(webUiIndex)) {
	fail(
		`${webUiIndex} is missing — the runtime is built but the web UI assets were not staged into dist/web-ui/.`,
	);
}

rmSync(stageDir, { recursive: true, force: true });
cpSync(distDir, stageDir, { recursive: true });

console.log(`[stage:cli] Staged ${distDir} → ${stageDir}`);
