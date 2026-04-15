/**
 * Type declaration for the kanban/runtime-start subpath export.
 *
 * Why a hand-maintained .d.ts instead of deriving from package exports?
 * The desktop package depends on `kanban` as an npm dependency (installed
 * from the monorepo root), but TypeScript cannot resolve the subpath export
 * `kanban/runtime-start` unless the consumer either uses `moduleResolution:
 * bundler`/`node16` with proper package.json `exports` types, or has an
 * ambient declaration. Electron's build toolchain compiles with `module:
 * commonjs` which does not resolve subpath exports. This .d.ts is the
 * pragmatic bridge.
 *
 * Maintenance: keep in sync with `src/runtime-start.ts` in the root package.
 * If the startRuntime signature changes, update this file.
 */
declare module "kanban/runtime-start" {
	export interface RuntimeCallbacks {
		pickDirectory?: () => Promise<string | null>;
		warn?: (message: string) => void;
	}
	export interface RuntimeStartOptions {
		host?: string;
		port?: number | "auto";
		authToken?: string;
		cwd?: string;
		isLocal?: boolean;
		openInBrowser?: boolean;
		callbacks?: RuntimeCallbacks;
	}
	/** @deprecated Use {@link RuntimeStartOptions} instead. */
	export type RuntimeOptions = RuntimeStartOptions;
	export interface RuntimeHandle {
		url: string;
		shutdown: (options?: { skipSessionCleanup?: boolean }) => Promise<void>;
	}
	export function startRuntime(options?: RuntimeStartOptions): Promise<RuntimeHandle>;
}
