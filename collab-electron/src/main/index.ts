import "./logger";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  session,
  shell,
  webContents as webContentsModule,
  type WebContents,
} from "electron";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fromCollabFileUrl } from "@collab/shared/collab-file-url";
import {
  loadConfig,
  saveConfig,
  getPref,
  setPref,
  type WindowState,
  type TerminalTarget,
} from "./config";
import { registerIpcHandlers, setMainWindow } from "./ipc";
import { registerCanvasRpc } from "./canvas-rpc";
import { registerIntegrationsIpc } from "./integrations";
import {
  registerMethod,
  startJsonRpcServer,
  stopJsonRpcServer,
} from "./json-rpc-server";
import * as watcher from "./watcher";
import * as gitReplay from "./git-replay";
import { DISABLE_GIT_REPLAY } from "@collab/shared/replay-types";
import * as pty from "./pty";
import { updateManager, setupUpdateIPC } from "./updater";
import {
  initMainAnalytics,
  trackEvent,
  shutdownAnalytics,
  getDeviceId,
} from "./analytics";
import { stopImageWorker } from "./image-service";
import { installCli } from "./cli-installer";
import { listTerminalTargets } from "./terminal-target";
import { readSessionMeta } from "./tmux";

// macOS apps launched from Finder don't inherit the user's shell
// LANG, so child processes (tmux, shells) default to ASCII.
if (!process.env.LANG || !process.env.LANG.includes("UTF-8")) {
  process.env.LANG = "en_US.UTF-8";
}

// Raise V8 heap limits for the main process and renderer processes.
// Each terminal webview is a separate renderer; heavy AI coding tools
// (Claude, Copilot) generate large scrollback that can exhaust the
// default ~1.4 GB heap.  Dev mode uses more memory (Vite HMR, longer
// sessions) so we allow a larger heap there.
//
// If NODE_OPTIONS already specifies --max-old-space-size (e.g. from
// dev.mjs / dev.ps1), honour that value instead of overriding it.
const DEFAULT_HEAP_MB = 8192;
const nodeOptsMatch = (process.env.NODE_OPTIONS ?? "").match(
  /--max-old-space-size=(\d+)/,
);
const heapMB = nodeOptsMatch
  ? Math.max(Number(nodeOptsMatch[1]), DEFAULT_HEAP_MB)
  : DEFAULT_HEAP_MB;
app.commandLine.appendSwitch("js-flags", `--max-old-space-size=${heapMB}`);

// Raise the maximum number of renderer processes Chromium will keep alive.
// Default is ~4 on some platforms; we need more for many terminal tiles.
app.commandLine.appendSwitch("renderer-process-limit", "20");

process.on("uncaughtException", (error) => {
  trackEvent("app_crash", {
    type: "uncaughtException",
    message: error.message,
    stack: error.stack,
  });
  console.error("[crash] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
  const error =
    reason instanceof Error ? reason : new Error(String(reason));
  trackEvent("app_crash", {
    type: "unhandledRejection",
    message: error.message,
    stack: error.stack,
  });
  console.error("[crash] Unhandled rejection:", error);
});

if (import.meta.env.DEV) {
  app.setPath("userData", join(app.getPath("userData"), "dev"));
}

let mainWindow: BrowserWindow | null = null;
let pendingFilePath: string | null = null;
let config = loadConfig();
let shuttingDown = false;

// Apply saved theme preference (light/dark/system)
const savedTheme = config.ui.theme;
if (savedTheme === "light" || savedTheme === "dark") {
  nativeTheme.themeSource = savedTheme;
} else {
  nativeTheme.themeSource = "system";
}
let globalZoomLevel = 0;

if (!app.isPackaged) {
  // Vite dev uses a relaxed renderer policy for HMR; suppress Electron's
  // repeated dev-only security banner so actionable logs stay visible.
  process.env["ELECTRON_DISABLE_SECURITY_WARNINGS"] = "true";
}

// macOS GUI apps launched from Finder get a minimal PATH from launchd.
// Resolve the user's full shell PATH so child processes (terminal, git) work.
if (app.isPackaged && process.platform === "darwin") {
  try {
    const shell = process.env["SHELL"] || "/bin/zsh";
    const output = execFileSync(
      shell,
      ["-l", "-c", 'printf "%s" "$PATH"'],
      { encoding: "utf8", timeout: 5000 },
    );
    const resolved = output.split("\n").pop()!;
    if (resolved.includes("/")) {
      process.env["PATH"] = resolved;
    }
  } catch {
    // Fall through with the default PATH if shell resolution fails.
  }
}

const DEFAULT_STATE: WindowState = {
  x: 0,
  y: 0,
  width: 1200,
  height: 800,
};

function boundsVisibleOnAnyDisplay(bounds: WindowState): boolean {
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const { x, y, width, height } = display.workArea;
    return (
      bounds.x < x + width &&
      bounds.x + bounds.width > x &&
      bounds.y < y + height &&
      bounds.y + bounds.height > y
    );
  });
}

function saveWindowState(state: WindowState): void {
  try {
    config.window_state = state;
    saveConfig(config);
  } catch (err) {
    console.error("Failed to save window state:", err);
  }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null;

function debouncedSaveWindowState(): void {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    const { x, y, width, height } = mainWindow.getNormalBounds();
    saveWindowState({ x, y, width, height });
  }, 500);
}

function sendShortcut(action: string): void {
  mainWindow?.webContents.send("shell:shortcut", action);
}

import {
  type BindingsMap,
  DEFAULT_KEYBINDINGS,
  mergeWithDefaults,
  matchesKeyCombo,
  comboToAccelerator,
} from "@collab/shared/keybindings";

let activeBindings: BindingsMap = mergeWithDefaults(
  getPref(config, "keybindings") as Partial<BindingsMap> | null ?? {},
);

const SHORTCUT_ACTIONS = [
  "toggle-nav", "toggle-terminal-list", "toggle-settings",
  "add-workspace", "focus-search", "new-tile", "close-tile",
];

function attachShortcutListener(target: WebContents): void {
  target.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;

    for (const actionId of SHORTCUT_ACTIONS) {
      const binding = activeBindings[actionId];
      if (!binding || binding.type !== "key") continue;
      if (matchesKeyCombo(input, binding.combo, process.platform)) {
        event.preventDefault();
        if (!input.isAutoRepeat) sendShortcut(actionId);
        return;
      }
    }
  });
}

function getAcceleratorFor(actionId: string): string | undefined {
  const binding = activeBindings[actionId];
  if (!binding || binding.type !== "key") return undefined;
  return comboToAccelerator(binding.combo, process.platform);
}

function isBrowserTileWebview(wc: WebContents): boolean {
  try {
    return wc.session === session.fromPartition("persist:browser");
  } catch {
    return false;
  }
}

function attachBrowserShortcuts(
  wc: WebContents,
  hostWindow: BrowserWindow,
): void {
  wc.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const cmd = input.meta || input.control;
    if (!cmd) {
      if (input.key === "Escape" && wc.isLoading()) {
        event.preventDefault();
        wc.stop();
      }
      return;
    }

    if (input.code === "KeyL" || input.key === "l") {
      event.preventDefault();
      hostWindow.webContents.send(
        "browser-tile:focus-url", wc.id,
      );
    } else if (input.code === "BracketLeft" || input.key === "[") {
      event.preventDefault();
      if (wc.canGoBack()) wc.goBack();
    } else if (input.code === "BracketRight" || input.key === "]") {
      event.preventDefault();
      if (wc.canGoForward()) wc.goForward();
    } else if (input.code === "KeyR" || input.key === "r") {
      event.preventDefault();
      wc.reload();
    }
  });
}

function registerToggleShortcuts(win: BrowserWindow): void {
  attachShortcutListener(win.webContents);

  win.webContents.on("did-attach-webview", (_event, wc) => {
    wc.once("did-finish-load", () => {
      attachShortcutListener(wc);
      if (isBrowserTileWebview(wc)) {
        attachBrowserShortcuts(wc, win);
      }
      if (globalZoomLevel !== 0) {
        wc.setZoomLevel(globalZoomLevel);
      }
    });
  });
}

function applyZoomToAll(level: number): void {
  globalZoomLevel = level;
  for (const wc of webContentsModule.getAllWebContents()) {
    if (!wc.isDestroyed()) wc.setZoomLevel(level);
  }
}

function buildAppMenu(): void {
  const isMac = process.platform === "darwin";
  const fullScreenAccelerator = isMac ? "Ctrl+Cmd+F" : "F11";

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              {
                label: "Settings\u2026",
                accelerator: getAcceleratorFor("toggle-settings"),
                registerAccelerator: false,
                click: () => sendShortcut("toggle-settings"),
              } as Electron.MenuItemConstructorOptions,
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Tile",
          accelerator: getAcceleratorFor("new-tile"),
          registerAccelerator: false,
          click: () => sendShortcut("new-tile"),
        },
        {
          label: "Close Tile",
          accelerator: getAcceleratorFor("close-tile"),
          registerAccelerator: false,
          click: () => sendShortcut("close-tile"),
        },
        { type: "separator" },
        {
          label: "Open Workspace\u2026",
          accelerator: getAcceleratorFor("add-workspace"),
          registerAccelerator: false,
          click: () => sendShortcut("add-workspace"),
        },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        {
          label: "Find",
          accelerator: getAcceleratorFor("focus-search"),
          registerAccelerator: false,
          click: () => sendShortcut("focus-search"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Navigator",
          accelerator: getAcceleratorFor("toggle-nav"),
          registerAccelerator: false,
          click: () => sendShortcut("toggle-nav"),
        },
        {
          label: "Toggle Terminal List",
          accelerator: getAcceleratorFor("toggle-terminal-list"),
          registerAccelerator: false,
          click: () => sendShortcut("toggle-terminal-list"),
        },
        { type: "separator" },
        {
          label: "Zoom In",
          accelerator: "CommandOrControl+=",
          click: () => applyZoomToAll(globalZoomLevel + 0.25),
        },
        {
          label: "Zoom Out",
          accelerator: "CommandOrControl+-",
          click: () => applyZoomToAll(globalZoomLevel - 0.25),
        },
        {
          label: "Actual Size",
          accelerator: "CommandOrControl+0",
          click: () => applyZoomToAll(0),
        },
        { type: "separator" },
        { role: "toggleDevTools" },
        {
          label: "Toggle Full Screen",
          accelerator: fullScreenAccelerator,
          click: (_, win) => win?.setFullScreen(!win.isFullScreen()),
        },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" as const },
              { role: "front" as const },
            ]
          : [{ role: "close" as const }]),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getPreloadPath(name: string): string {
  return join(__dirname, `../preload/${name}.js`);
}

function getRendererURL(name: string): string {
  if (!app.isPackaged && process.env["ELECTRON_RENDERER_URL"]) {
    return `${process.env["ELECTRON_RENDERER_URL"]}/${name}/index.html`;
  }
  return pathToFileURL(
    join(__dirname, `../renderer/${name}/index.html`),
  ).href;
}

function createWindow(): void {
  const saved = config.window_state;
  const useSaved =
    saved !== null &&
    (saved.isMaximized || boundsVisibleOnAnyDisplay(saved));
  const state = useSaved ? saved : DEFAULT_STATE;

  const windowOptions: Electron.BrowserWindowConstructorOptions = {
    width: state.width,
    height: state.height,
    minWidth: 400,
    minHeight: 400,
    webPreferences: {
      preload: getPreloadPath("shell"),
      contextIsolation: true,
      sandbox: true,
      webviewTag: true,
    },
  };

  if (process.platform === "darwin") {
    Object.assign(windowOptions, {
      titleBarStyle: "hidden",
      vibrancy: "under-window",
      visualEffectState: "active",
      trafficLightPosition: { x: 14, y: 12 },
    } satisfies Partial<Electron.BrowserWindowConstructorOptions>);
  }

  if (process.platform === "win32") {
    Object.assign(windowOptions, {
      backgroundColor: "#00000000",
      backgroundMaterial: "mica",
    } satisfies Partial<Electron.BrowserWindowConstructorOptions>);
  }

  if (useSaved) {
    windowOptions.x = state.x;
    windowOptions.y = state.y;
  }

  mainWindow = new BrowserWindow(windowOptions);

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.on("move", debouncedSaveWindowState);
  mainWindow.on("resize", debouncedSaveWindowState);
  mainWindow.on("close", () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const { x, y, width, height } = mainWindow.getNormalBounds();
    saveWindowState({
      x,
      y,
      width,
      height,
      isMaximized: mainWindow.isMaximized(),
    });
  });
  mainWindow.loadURL(getRendererURL("shell"));

  setMainWindow(mainWindow);
  registerCanvasRpc(mainWindow);
}

ipcMain.handle(
  "analytics:get-device-id",
  () => getDeviceId(),
);

ipcMain.on("analytics:track-event", (_event, name, properties) => {
  trackEvent(name, properties);
});

ipcMain.handle("shell:get-view-config", () => {
  const preload = pathToFileURL(
    getPreloadPath("universal"),
  ).href;

  return {
    nav: { src: getRendererURL("nav"), preload },
    viewer: { src: getRendererURL("viewer"), preload },
    terminal: { src: getRendererURL("terminal"), preload },
    terminalTile: { src: getRendererURL("terminal-tile"), preload },
    graphTile: { src: getRendererURL("graph-tile"), preload },
    settings: { src: getRendererURL("settings"), preload },
    terminalList: { src: getRendererURL("terminal-list"), preload },
  };
});

ipcMain.handle(
  "pref:get",
  (_event, key: string) => getPref(config, key),
);

ipcMain.handle(
  "pref:set",
  (_event, key: string, value: unknown) => {
    setPref(config, key, value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("pref:changed", key, value);
    }
    if (key === "keybindings") {
      activeBindings = mergeWithDefaults(
        value as Partial<BindingsMap> ?? {},
      );
      buildAppMenu();
    }
  },
);

ipcMain.handle(
  "terminal:list-targets",
  () => listTerminalTargets(),
);

ipcMain.handle(
  "theme:set",
  (_event, mode: string) => {
    const valid = mode === "light" || mode === "dark" ? mode : "system";
    nativeTheme.themeSource = valid;
    setPref(config, "theme", valid);
  },
);

ipcMain.handle(
  "pty:create",
  (
    event,
    params?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      tileId?: string;
      target?: TerminalTarget;
    },
  ) =>
    pty.createSession(
      params?.cwd,
      event.sender.id,
      params?.cols,
      params?.rows,
      params?.target,
      params?.tileId,
    ),
);

// Fire-and-forget path (universal preload → terminal tiles: low-latency keystrokes)
ipcMain.on(
  "pty:write",
  (_event, { sessionId, data }: { sessionId: string; data: string }) => {
    pty.writeToSession(sessionId, data);
  },
);
// Async invoke path (shell preload → canvas RPC terminalWrite)
ipcMain.handle(
  "pty:write-invoke",
  (_event, { sessionId, data }: { sessionId: string; data: string }) => {
    pty.writeToSession(sessionId, data);
  },
);

ipcMain.handle(
  "pty:send-raw-keys",
  (_event, { sessionId, data }: { sessionId: string; data: string }) =>
    pty.sendRawKeys(sessionId, data),
);

ipcMain.handle(
  "pty:resize",
  (
    _event,
    {
      sessionId,
      cols,
      rows,
    }: { sessionId: string; cols: number; rows: number },
  ) => pty.resizeSession(sessionId, cols, rows),
);

ipcMain.handle(
  "pty:kill",
  (_event, { sessionId }: { sessionId: string }) =>
    pty.killSession(sessionId),
);

ipcMain.handle(
  "pty:reconnect",
  (
    event,
    {
      sessionId,
      cols,
      rows,
    }: { sessionId: string; cols: number; rows: number },
  ) =>
    pty.reconnectSession(
      sessionId, cols, rows, event.sender.id,
    ),
);

ipcMain.handle(
  "pty:discover",
  () => pty.discoverSessions(),
);

ipcMain.handle(
  "pty:read-meta",
  (_event, sessionId: string) => readSessionMeta(sessionId),
);

ipcMain.handle(
  "pty:clean-detached",
  (_event, activeSessionIds: string[]) =>
    pty.cleanDetachedSessions(activeSessionIds),
);

ipcMain.handle(
  "pty:foreground-process",
  (_event, sessionId: string) => pty.getForegroundProcess(sessionId),
);

ipcMain.handle(
  "pty:capture",
  (
    _event,
    { sessionId, lines }: { sessionId: string; lines?: number },
  ) => pty.captureSession(sessionId, lines),
);

let settingsOpen = false;

function setSettingsOpen(open: boolean): void {
  if (!mainWindow || settingsOpen === open) return;
  settingsOpen = open;
  mainWindow.webContents.send("shell:settings", open ? "open" : "close");
}

ipcMain.on("settings:open", () => setSettingsOpen(true));

const LOG_FN_BY_LEVEL: Record<number, (...args: unknown[]) => void> = {
  0: console.debug,
  1: console.log,
  2: console.warn,
  3: console.error,
};

ipcMain.on(
  "webview:console",
  (_event, panel: string, level: number, message: string, source: string) => {
    const tag = `[webview:${panel}]`;
    const logFn = LOG_FN_BY_LEVEL[level] ?? console.log;
    logFn(`${tag} ${message}`, source ? `(${source})` : "");
  },
);

ipcMain.on("settings:close", () => setSettingsOpen(false));
ipcMain.on("settings:toggle", () => setSettingsOpen(!settingsOpen));

function sendLoadingDone(): void {
  mainWindow?.webContents.send("shell:loading-done");
}

async function shutdownBackgroundServices(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  pty.setShuttingDown(true);
  await pty.killAllAndWait();
  await pty.shutdownSidecarIfIdle();
  watcher.stopWorker();
  if (!DISABLE_GIT_REPLAY) gitReplay.stopWorker();
  stopJsonRpcServer();
  stopImageWorker();
}

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(
      "shell:forward", "viewer", "file-selected", path,
    );
  } else {
    pendingFilePath = path;
  }
});

protocol.registerSchemesAsPrivileged([
  {
    scheme: "collab-file",
    privileges: {
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

app.on("web-contents-created", (_event, contents) => {
  const isExternal = (url: string): boolean => {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return false;
    }
    const devOrigin = process.env["ELECTRON_RENDERER_URL"];
    if (devOrigin && url.startsWith(devOrigin)) return false;
    return true;
  };

  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isBrowserTileWebview(contents)) {
      if (disposition === "foreground-tab" || disposition === "background-tab") {
        mainWindow?.webContents.send(
          "shell:forward", "canvas", "open-browser-tile", url,
          contents.id,
        );
        return { action: "deny" };
      }
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 500,
          height: 600,
          webPreferences: {
            partition: "persist:browser",
          },
        },
      };
    }
    if (isExternal(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (isExternal(url) && !isBrowserTileWebview(contents)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
});

app.whenReady().then(async () => {
  // Set a standard Chrome user-agent on the browser tile session so sites
  // (especially Google OAuth) treat it as a real browser, not an embedded webview.
  const browserSession = session.fromPartition("persist:browser");
  const electronUA = browserSession.getUserAgent();
  browserSession.setUserAgent(
    electronUA.replace(/\s*Electron\/\S+/, ""),
  );

  protocol.handle("collab-file", (request) => {
    const filePath = fromCollabFileUrl(request.url);
    return net.fetch(pathToFileURL(filePath).toString());
  });

  shuttingDown = false;

  console.log(
    `[startup] V8 heap limit: ${heapMB} MB` +
      (import.meta.env.DEV ? " (dev mode)" : ""),
  );

  config = loadConfig();
  installCli();
  watcher.startWorker();
  registerIpcHandlers(config);
  registerIntegrationsIpc();
  setupUpdateIPC();
  updateManager.init({
    onBeforeQuit: () => shutdownBackgroundServices(),
  });

  try {
    await pty.ensureSidecar();
  } catch (err) {
    console.error("Sidecar failed to start:", err);
  }

  buildAppMenu();
  createWindow();
  registerToggleShortcuts(mainWindow!);

  initMainAnalytics();
  trackEvent("app_launched");

  mainWindow!.webContents.on("did-finish-load", () => {
    sendLoadingDone();
    if (pendingFilePath) {
      mainWindow!.webContents.send(
        "shell:forward", "viewer", "file-selected", pendingFilePath,
      );
      pendingFilePath = null;
    }
  });

  // -- Process crash / OOM logging --

  mainWindow!.webContents.on("render-process-gone", (_event, details) => {
    console.error("[crash] Shell renderer gone:", details.reason, details);
    trackEvent("renderer_crash", {
      target: "shell",
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  mainWindow!.on("unresponsive", () => {
    console.error("[crash] Main window unresponsive");
    trackEvent("renderer_crash", { target: "shell", reason: "unresponsive" });
  });

  app.on("child-process-gone", (_event, details) => {
    console.error(
      `[crash] Child process gone: type=${details.type} reason=${details.reason}`,
      details,
    );
    trackEvent("child_process_crash", {
      type: details.type,
      reason: details.reason,
      serviceName: details.serviceName ?? "",
      name: details.name ?? "",
      exitCode: details.exitCode,
    });
  });

  // Log webview (terminal/browser tile) renderer crashes
  mainWindow!.webContents.on("did-attach-webview", (_event, wc) => {
    wc.on("render-process-gone", (_e, details) => {
      console.error(
        `[crash] Webview renderer gone (pid=${wc.getOSProcessId()}):`,
        details.reason, details,
      );
      trackEvent("renderer_crash", {
        target: "webview",
        reason: details.reason,
        exitCode: details.exitCode,
      });
    });
  });

  registerMethod("ping", () => ({ pong: true }), {
    description: "Health check — returns {pong: true}",
  });
  registerMethod("workspace.getConfig", () => config, {
    description: "Return the current app configuration",
  });

  // -- Memory pressure watchdog --
  // Periodically check the main-process heap and log diagnostics so
  // memory leaks are caught before they trigger an OOM crash.
  const HEAP_CHECK_INTERVAL_MS = 60_000; // every 60 s
  const HEAP_DIAG_INTERVAL_MS = 5 * 60_000; // detailed log every 5 min
  const HEAP_WARN_RATIO = 0.70;
  const HEAP_CRIT_RATIO = 0.85;
  const heapLimitBytes = heapMB * 1024 * 1024;
  let lastHeapLevel: "ok" | "warn" | "critical" = "ok";
  let lastDiagTime = 0;

  setInterval(() => {
    const mem = process.memoryUsage();
    const ratio = mem.heapUsed / heapLimitBytes;
    const usedMB = Math.round(mem.heapUsed / 1024 / 1024);
    const totalMB = Math.round(mem.heapTotal / 1024 / 1024);
    const rssMB = Math.round(mem.rss / 1024 / 1024);
    const externalMB = Math.round(mem.external / 1024 / 1024);

    // Periodic detailed diagnostics (every 5 min)
    const now = Date.now();
    if (now - lastDiagTime >= HEAP_DIAG_INTERVAL_MS) {
      lastDiagTime = now;
      console.log(
        `[memory] heap: ${usedMB}/${totalMB} MB (${(ratio * 100).toFixed(0)}% of ${heapMB} MB limit)` +
          ` | rss: ${rssMB} MB | external: ${externalMB} MB`,
      );

      // Log per-process memory breakdown to identify which process grows
      try {
        const metrics = app.getAppMetrics();
        const summary = metrics.map((m) => {
          const mem = m.memory;
          return `${m.type}(pid=${m.pid}): ${Math.round(mem.workingSetSize / 1024)} MB`;
        });
        console.log(`[memory] processes: ${summary.join(" | ")}`);
        console.log(
          `[memory] pty sessions: ${pty.listSessions().length}`,
        );
      } catch {
        // getAppMetrics may fail during shutdown
      }
    }

    // Warning threshold
    if (
      ratio >= HEAP_WARN_RATIO &&
      ratio < HEAP_CRIT_RATIO &&
      lastHeapLevel === "ok"
    ) {
      lastHeapLevel = "warn";
      console.warn(
        `[memory] WARNING: heap ${usedMB} MB / ${heapMB} MB (${(ratio * 100).toFixed(0)}%)`,
      );
      trackEvent("memory_pressure", {
        level: "warn",
        heapUsedMB: usedMB,
        heapLimitMB: heapMB,
        rssMB,
      });
      dialog.showMessageBox({
        type: "warning",
        title: "High Memory Usage",
        message: `Collaborator is using ${usedMB} MB of ${heapMB} MB available memory (${(ratio * 100).toFixed(0)}%).`,
        detail:
          "Consider closing unused terminals or restarting the app to free memory.",
        buttons: ["OK"],
        noLink: true,
      });
    }

    // Critical threshold
    if (ratio >= HEAP_CRIT_RATIO && lastHeapLevel !== "critical") {
      lastHeapLevel = "critical";
      console.error(
        `[memory] CRITICAL: heap ${usedMB} MB / ${heapMB} MB (${(ratio * 100).toFixed(0)}%)`,
      );
      trackEvent("memory_pressure", {
        level: "critical",
        heapUsedMB: usedMB,
        heapLimitMB: heapMB,
        rssMB,
      });
      dialog.showMessageBox({
        type: "error",
        title: "Critical Memory Usage",
        message: `Collaborator is using ${usedMB} MB of ${heapMB} MB available memory (${(ratio * 100).toFixed(0)}%).`,
        detail:
          "The app may crash soon. Please close terminals and restart the app.",
        buttons: ["OK"],
        noLink: true,
      });
    }

    if (ratio < HEAP_WARN_RATIO) {
      lastHeapLevel = "ok";
    }
  }, HEAP_CHECK_INTERVAL_MS).unref();

  try {
    await startJsonRpcServer();
  } catch (err) {
    console.error("Failed to start JSON-RPC server:", err);
  }
});

app.on("before-quit", (event) => {
  if (!shuttingDown) {
    event.preventDefault();
    shutdownBackgroundServices().then(() => app.quit());
  }
});

app.on("window-all-closed", async () => {
  await shutdownBackgroundServices();
  await shutdownAnalytics();
  app.quit();
});
