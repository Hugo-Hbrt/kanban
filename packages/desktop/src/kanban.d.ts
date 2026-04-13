/** Type declaration for the kanban/runtime-start subpath export. */
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

/** Type declaration for the kanban package. */
declare module "kanban" {
	export function listWorkspaceIndexEntries(): Promise<Array<{ repoPath: string }>>;
	export function loadWorkspaceState(repoPath: string): Promise<{
		board: {
			columns: Array<{
				id: string;
				cards: Array<{ id: string }>;
			}>;
		};
	}>;

	export interface RuntimeDescriptor {
		url: string;
		authToken: string;
		pid: number;
		updatedAt: string;
		source?: "desktop" | "terminal";
		desktopSessionId?: string;
	}

	export interface DescriptorTrustResult {
		trusted: boolean;
		reason:
			| "no-descriptor"
			| "current-session"
			| "terminal-owned"
			| "prior-desktop-session"
			| "pid-dead";
		descriptor: RuntimeDescriptor | null;
	}

	export function readRuntimeDescriptor(): Promise<RuntimeDescriptor | null>;
	export function writeRuntimeDescriptor(descriptor: RuntimeDescriptor): Promise<void>;
	export function clearRuntimeDescriptor(): Promise<void>;
	export function evaluateDescriptorTrust(currentSessionId: string): Promise<DescriptorTrustResult>;
}
