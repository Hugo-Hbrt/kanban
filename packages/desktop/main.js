/**
 * Electron main process — composition root.
 *
 * All domain logic lives in the helper modules:
 *   • {@link RuntimeOrchestrator} — runtime child lifecycle + health.
 *   • {@link WindowFactory}        — window creation + renderer recovery.
 *   • {@link AppMenu}              — application menu.
 *   • {@link WindowRegistry}       — window tracking + state persistence.
 *   • {@link registerProtocol}     — kanban:// deep-link handling.
 *
 * This file wires them together and owns only:
 *   • App lifecycle events (whenReady / before-quit / will-quit / activate).
 *   • Single-instance lock and second-instance argv dispatch.
 *   • IPC handlers backed by the preload bridge.
 *   • Startup flow: preflight → create windows → connect runtime.
 */
import { BrowserWindow, app, dialog, ipcMain } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AppMenu } from "./app-menu.js";
import { runDesktopPreflight } from "./desktop-preflight.js";
import { relayOAuthCallback } from "./oauth-relay.js";
import { extractProtocolUrlFromArgv, parseProtocolUrl, registerProtocol, } from "./protocol-handler.js";
import { RuntimeOrchestrator } from "./runtime-orchestrator.js";
import { WindowFactory } from "./window-factory.js";
import { WindowRegistry } from "./window-registry.js";
const BACKGROUND_COLOR = "#1F2428";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3484;
const HEALTH_TIMEOUT_MS = 3_000;
const preloadPath = path.join(import.meta.dirname, "preload.js");
const disconnectedHtmlPath = path.join(import.meta.dirname, "disconnected.html");
// These two calls must run before `app.whenReady()`.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
registerProtocol(app);
// E2E state isolation — lets integration tests point Electron at a scratch
// userData dir so they don't clobber the developer's real window state.
if (process.env.KANBAN_DESKTOP_USER_DATA) {
    app.setPath("userData", process.env.KANBAN_DESKTOP_USER_DATA);
}
// Helper modules — instantiated at module load, wired after lock acquisition.
let isQuitting = false;
const registry = new WindowRegistry();
const orchestrator = new RuntimeOrchestrator({
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    healthTimeoutMs: HEALTH_TIMEOUT_MS,
    resolveCliShimPath,
});
const windowFactory = new WindowFactory({
    preloadPath,
    isPackaged: app.isPackaged,
    backgroundColor: BACKGROUND_COLOR,
    disconnectedHtmlPath,
    registry,
    orchestrator,
    isQuitting: () => isQuitting,
    onMenuDirty: () => menu.rebuild(),
});
const menu = new AppMenu({
    registry,
    orchestrator,
    onNewWindow: ({ initialPath }) => windowFactory.create({ projectId: null, initialPath }),
});
// Runtime URL changes and crashes both propagate through the factory:
// URL changes → reload all windows at the new origin; crashes → disconnected.
orchestrator.on("url-changed", (url) => {
    if (url)
        void registry.loadUrlInAllWindows(url);
    menu.rebuild();
});
orchestrator.on("crashed", () => windowFactory.showDisconnectedScreen());
function handleProtocolUrl(raw) {
    const parsed = parseProtocolUrl(raw);
    const runtimeUrl = orchestrator.getUrl();
    if (!parsed?.isOAuthCallback || !runtimeUrl)
        return;
    const relayTarget = new URL("/kanban-mcp/mcp-oauth-callback", runtimeUrl);
    for (const [key, value] of parsed.searchParams.entries()) {
        relayTarget.searchParams.set(key, value);
    }
    const focusedWindow = registry.getFocused();
    relayOAuthCallback(relayTarget.toString(), null, {
        fetch: globalThis.fetch,
        getMainWindow: () => focusedWindow,
    }).catch((err) => console.error("[desktop] OAuth relay error:", err));
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        if (focusedWindow.isMinimized())
            focusedWindow.restore();
        focusedWindow.show();
        focusedWindow.focus();
    }
}
app.on("open-url", (event, url) => {
    event.preventDefault();
    handleProtocolUrl(url);
});
function resolveCliShimPath() {
    if (app.isPackaged) {
        const shimName = process.platform === "win32" ? "kanban.cmd" : "kanban";
        return path.join(process.resourcesPath, "bin", shimName);
    }
    const devShimName = process.platform === "win32" ? "kanban-dev.cmd" : "kanban-dev";
    return path.join(import.meta.dirname, "..", "build", "bin", devShimName);
}
function parseProjectFromArgv(argv) {
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--project" && i + 1 < argv.length) {
            const value = argv[i + 1];
            if (value && !value.startsWith("-"))
                return value;
        }
        if (arg.startsWith("--project=")) {
            const value = arg.slice("--project=".length);
            if (value)
                return value;
        }
    }
    return null;
}
ipcMain.on("open-project-window", (_event, projectId) => {
    if (typeof projectId === "string" && projectId) {
        windowFactory.create({ projectId });
    }
});
ipcMain.on("restart-runtime", async () => {
    console.log("[desktop] Restart requested from renderer.");
    try {
        await orchestrator.restart();
    }
    catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[desktop] Failed to restart runtime: ${msg}`);
        dialog.showErrorBox("Kanban Startup Error", `Failed to restart runtime:\n\n${msg}`);
    }
});
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
}
else {
    app.on("second-instance", (_event, argv) => {
        const protocolUrl = extractProtocolUrlFromArgv(argv);
        if (protocolUrl)
            handleProtocolUrl(protocolUrl);
        const projectId = parseProjectFromArgv(argv);
        if (projectId) {
            windowFactory.create({ projectId });
            return;
        }
        const focused = registry.getFocused();
        if (focused) {
            if (focused.isMinimized())
                focused.restore();
            focused.focus();
        }
    });
    wireAppLifecycle();
}
function wireAppLifecycle() {
    app.whenReady().then(async () => {
        await mkdir(app.getPath("userData"), { recursive: true }).catch(() => { });
        const cliShimPath = resolveCliShimPath();
        const preflight = runDesktopPreflight({
            preloadPath,
            cliShimPath,
            isPackaged: app.isPackaged,
        });
        if (!preflight.ok) {
            const details = preflight.failures
                .map((f) => `[${f.code}] ${f.message}`)
                .join("\n\n");
            dialog.showErrorBox("Kanban Startup Error", `Startup preflight failed:\n\n${details}`);
            return;
        }
        // Preflight warnings are non-fatal but worth surfacing so that a
        // user reporting "terminals don't work" has a breadcrumb in logs.
        for (const warning of preflight.warnings) {
            console.warn(`[desktop] Preflight warning [${warning.code}]: ${warning.message}`);
        }
        const persistedStates = WindowRegistry.loadPersistedWindows(app.getPath("userData"));
        if (persistedStates.length > 0) {
            for (const savedState of persistedStates) {
                windowFactory.create({ projectId: savedState.projectId, savedState });
            }
        }
        else {
            windowFactory.create();
        }
        menu.rebuild();
        orchestrator.startAppNapPrevention();
        try {
            await orchestrator.connect();
        }
        catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.error(`[desktop] Failed to start runtime: ${msg}`);
            dialog.showErrorBox("Kanban Startup Error", `Failed to start runtime:\n\n${msg}`);
        }
        // macOS: re-create window when dock icon clicked and no windows exist.
        app.on("activate", () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                windowFactory.create();
            }
            else {
                const focused = registry.getFocused();
                if (focused && !focused.isVisible())
                    focused.show();
            }
        });
    });
    app.on("window-all-closed", () => {
        if (process.platform !== "darwin")
            app.quit();
    });
    app.on("before-quit", async (event) => {
        if (isQuitting)
            return;
        isQuitting = true;
        registry.saveAllStates(app.getPath("userData"));
        // Only hold the quit if we need to cleanly shut down a child we own.
        // Attached-to-existing-runtime mode has nothing to clean up.
        //
        // try/finally guarantees `app.quit()` still runs if shutdown()
        // rejects — otherwise a rejected shutdown would leave the app
        // hanging after the user asked it to quit.
        if (orchestrator.isOwned()) {
            event.preventDefault();
            try {
                await orchestrator.shutdown();
            }
            catch (err) {
                console.error("[desktop] Runtime shutdown error during quit:", err instanceof Error ? err.message : err);
            }
            finally {
                app.quit();
            }
        }
        else {
            orchestrator.stopAppNapPrevention();
        }
    });
    app.on("will-quit", async () => {
        await orchestrator.dispose();
    });
}
//# sourceMappingURL=main.js.map