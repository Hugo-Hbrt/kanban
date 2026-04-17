import * as esbuild from "esbuild";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Modules that must stay external (native addons, large runtime deps that
 * don't bundle cleanly, or deps using dynamic require patterns).
 *
 * These are resolved at runtime via Node's node_modules lookup. For the CLI
 * to work outside of its npm-install context (e.g. packaged inside the
 * Electron desktop app at `Resources/cli/cli.js`), we also stage these deps
 * into `dist/node_modules/` below so `dist/` is a self-contained deployable.
 */
const external = [
	"node-pty",
	"@sentry/node",
	"proper-lockfile",
	"tree-kill",
	"ws",
	"open",
	"@trpc/client",
	"@trpc/server",
	"@modelcontextprotocol/sdk",
	"commander",
	"zod",
];

/** Bake OTEL telemetry env vars into the bundle at build time. */
const define = {
	"process.env.NODE_ENV": '"production"',
	"process.env.OTEL_TELEMETRY_ENABLED": JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_ENDPOINT": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? ""),
	"process.env.OTEL_METRICS_EXPORTER": JSON.stringify(process.env.OTEL_METRICS_EXPORTER ?? ""),
	"process.env.OTEL_LOGS_EXPORTER": JSON.stringify(process.env.OTEL_LOGS_EXPORTER ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_PROTOCOL": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? ""),
	"process.env.OTEL_METRIC_EXPORT_INTERVAL": JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? ""),
	"process.env.OTEL_EXPORTER_OTLP_HEADERS": JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS ?? ""),
};

/**
 * Bundled CJS dependencies call require() on Node built-ins (process, fs, etc.).
 * ESM output needs a real require() function for those calls to work.
 */
const cjsShimBanner = [
	'import { createRequire as __kanban_createRequire } from "node:module";',
	"const require = __kanban_createRequire(import.meta.url);",
].join("\n");

/** Shared esbuild options for both entry points. */
const shared = {
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node20",
	external,
	define,
	sourcemap: true,
	packages: "bundle",
	banner: { js: cjsShimBanner },
};

await Promise.all([
	// CLI binary
	esbuild.build({
		...shared,
		entryPoints: ["src/cli.ts"],
		outfile: "dist/cli.js",
		banner: { js: `#!/usr/bin/env node\n${cjsShimBanner}` },
	}),
	// Library export
	esbuild.build({
		...shared,
		entryPoints: ["src/index.ts"],
		outfile: "dist/index.js",
	}),
]);

console.log("esbuild: bundled dist/cli.js and dist/index.js");

// ---------------------------------------------------------------------------
// Stage external runtime deps into dist/node_modules/
// ---------------------------------------------------------------------------
//
// cli.js has literal `import "zod"` / `require("ws")` statements for every
// name in `external`. Node resolves those via node_modules lookup starting
// from cli.js's location. When the CLI is run normally (`npm i -g kanban`),
// the enclosing node_modules/ satisfies resolution. But when `dist/` ships
// anywhere else — notably the Electron desktop app at `Resources/cli/` —
// there is no enclosing node_modules/.
//
// So we install the externals directly into `dist/node_modules/`, making
// `dist/` a fully self-contained deployable. One `npm install` with a
// synthetic package.json pulls in transitive deps automatically.

const rootPkg = JSON.parse(readFileSync("package.json", "utf-8"));
const rootDeps = { ...rootPkg.dependencies, ...rootPkg.devDependencies };
const runtimeDeps = Object.fromEntries(
	external
		.map((name) => [name, rootDeps[name]])
		.filter(([, v]) => typeof v === "string"),
);

const missing = external.filter((name) => !(name in runtimeDeps));
if (missing.length > 0) {
	throw new Error(
		`build.mjs: externals missing from root package.json: ${missing.join(", ")}`,
	);
}

mkdirSync("dist", { recursive: true });
writeFileSync(
	"dist/package.json",
	`${JSON.stringify(
		{
			name: "kanban-cli-runtime-deps",
			version: "0.0.0",
			private: true,
			type: "module",
			dependencies: runtimeDeps,
		},
		null,
		2,
	)}\n`,
);

console.log("staging runtime deps into dist/node_modules/ ...");
execSync("npm install --omit=dev --no-audit --no-fund --ignore-scripts", {
	cwd: "dist",
	stdio: "inherit",
});
console.log(`staged ${Object.keys(runtimeDeps).length} runtime deps`);
