/**
 * Environment and PATH policy for the Kanban CLI subprocess.
 *
 * Isolated from runtime-child.ts so the process-lifecycle code stays
 * focused on spawn/poll/kill concerns. Two policy decisions live here:
 *
 *   1. Which env vars are forwarded to the child. Everything is opt-in
 *      (exact-match allowlist + prefix allowlist) to avoid leaking
 *      arbitrary shell state into agent sessions.
 *   2. Which platform-specific directories are appended to PATH. GUI-
 *      launched processes on macOS/Linux/Windows inherit a minimal PATH
 *      that typically omits Homebrew, npm-global, nvm, Git for Windows,
 *      etc. Agent shells need those binaries findable by name.
 */

import path, { join } from "node:path";

/** Exact env var names forwarded verbatim from the parent process. */
export const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"PATHEXT",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SYSTEMROOT",
	"COMSPEC",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"NODE_ENV",
	"SHELL",
	"TERM",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES",
	"ProgramFiles(x86)",
	"ProgramData",
	"SYSTEMDRIVE",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
]);

/** Prefixes forwarded verbatim — provider API keys and KANBAN_* config. */
export const ALLOWED_ENV_PREFIXES: readonly string[] = [
	"KANBAN_",
	"ANTHROPIC_",
	"OPENAI_",
	"OPENROUTER_",
	"GOOGLE_",
	"GEMINI_",
	"AWS_",
	"AZURE_",
	"MISTRAL_",
	"DEEPSEEK_",
	"GROQ_",
	"XAI_",
	"FIREWORKS_",
	"TOGETHER_",
	"COHERE_",
	"PERPLEXITY_",
	"CEREBRAS_",
	"OCA_",
	"CLINE_",
];

/**
 * Windows-specific PATH dirs that depend on per-user environment variables
 * (APPDATA / LOCALAPPDATA / ProgramFiles). Separated from the macOS/Linux
 * static list into a function purely for readability; the env vars are read
 * once when this module is imported, same as the POSIX constants below.
 */
function getWindowsExtraPathDirs(): string[] {
	const dirs: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	const appData = process.env.APPDATA;
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	if (appData) dirs.push(join(appData, "npm")); // npm global
	if (localAppData) {
		dirs.push(join(localAppData, "Programs", "nodejs"));
		// WinGet places shim executables in `…\WinGet\Links\` (not
		// `…\WinGet\Packages\`, which holds install directories that
		// aren't directly on PATH).
		dirs.push(join(localAppData, "Microsoft", "WinGet", "Links"));
	}
	if (programFiles) dirs.push(join(programFiles, "Git", "cmd"));
	if (programFilesX86) dirs.push(join(programFilesX86, "Git", "cmd"));
	return dirs;
}

/**
 * Directories appended to PATH for GUI-launched desktop processes.
 * macOS launchd and Linux desktop-file launches typically give minimal
 * PATHs; these ensure Homebrew, Snap, Git, etc. are findable.
 */
const EXTRA_PATH_DIRS: readonly string[] =
	process.platform === "darwin"
		? [
				"/opt/homebrew/bin",
				"/opt/homebrew/sbin",
				"/usr/local/bin",
				"/usr/local/sbin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
			]
		: process.platform === "linux"
			? ["/usr/local/bin", "/snap/bin", "/usr/bin", "/bin"]
			: process.platform === "win32"
				? getWindowsExtraPathDirs()
				: [];

/**
 * Build a filtered copy of process.env containing only allowlisted keys
 * and prefixes, with PATH enriched for GUI-launched processes.
 */
export function buildFilteredEnv(): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};

	for (const key of ALLOWED_ENV_KEYS) {
		if (process.env[key] !== undefined) filtered[key] = process.env[key];
	}

	for (const key of Object.keys(process.env)) {
		if (filtered[key] !== undefined) continue;
		for (const prefix of ALLOWED_ENV_PREFIXES) {
			if (key.startsWith(prefix)) {
				filtered[key] = process.env[key];
				break;
			}
		}
	}

	if (EXTRA_PATH_DIRS.length > 0) {
		const pathParts = new Set((filtered.PATH ?? "").split(path.delimiter).filter(Boolean));
		for (const dir of EXTRA_PATH_DIRS) pathParts.add(dir);
		filtered.PATH = [...pathParts].join(path.delimiter);
	}

	return filtered;
}
