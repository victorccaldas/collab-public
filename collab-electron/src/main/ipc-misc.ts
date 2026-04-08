import {
  ipcMain,
  dialog,
  Menu,
  Notification,
  shell,
  BrowserWindow,
} from "electron";
import * as gitReplay from "./git-replay";
import { importWebArticle } from "./import-service";
import * as agentActivity from "./agent-activity";
import { registerMethod } from "./json-rpc-server";
import { DISABLE_GIT_REPLAY } from "@collab/shared/replay-types";

interface IpcContext {
  mainWindow: () => BrowserWindow | null;
  getActiveWorkspacePath: () => string | null;
  getWorkspaceConfig: (path: string) => any;
  fileFilter: () => any | null;
  forwardToWebview: (
    target: string,
    channel: string,
    ...args: unknown[]
  ) => void;
  trackEvent: (
    name: string,
    props?: Record<string, unknown>,
  ) => void;
}

export function registerMiscHandlers(
  ctx: IpcContext,
): void {
  // Dialog: open folder
  ipcMain.handle("dialog:open-folder", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  });

  // Dialog: open image
  ipcMain.handle("dialog:open-image", async () => {
    const win = ctx.mainWindow();
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [
        {
          name: "Images",
          extensions: [
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "tiff",
            "tif",
            "avif",
            "heic",
            "heif",
          ],
        },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0]!;
  });

  // Dialog: confirm
  ipcMain.handle(
    "dialog:confirm",
    async (
      _event,
      opts: {
        message: string;
        detail?: string;
        buttons?: string[];
      },
    ) => {
      const win = ctx.mainWindow();
      if (!win) return 0;
      const result = await dialog.showMessageBox(win, {
        type: "warning",
        message: opts.message,
        detail: opts.detail,
        buttons: opts.buttons ?? ["OK", "Cancel"],
      });
      return result.response;
    },
  );

  // Dialog: text input (replaces window.prompt which is blocked in sandboxed webviews)
  ipcMain.handle(
    "dialog:input",
    async (
      _event,
      opts: {
        title?: string;
        label?: string;
        defaultValue?: string;
      },
    ) => {
      const parent = ctx.mainWindow();
      if (!parent) return null;

      return new Promise<string | null>((resolve) => {
        const win = new BrowserWindow({
          parent,
          modal: true,
          width: 480,
          height: 180,
          resizable: false,
          minimizable: false,
          maximizable: false,
          show: false,
          frame: false,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
          },
        });

        const title = opts.title ?? "Input";
        const label = opts.label ?? "";
        const defaultValue = (opts.defaultValue ?? "").replace(/"/g, "&quot;");

        const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  padding: 16px; background: #1e1e1e; color: #ccc; display: flex; flex-direction: column; height: 100vh; }
h3 { font-size: 13px; margin-bottom: 8px; color: #eee; }
label { font-size: 12px; margin-bottom: 6px; display: block; }
input { width: 100%; padding: 6px 8px; font-size: 13px; border: 1px solid #555; border-radius: 4px;
  background: #2d2d2d; color: #eee; outline: none; }
input:focus { border-color: #007acc; }
.buttons { margin-top: auto; display: flex; justify-content: flex-end; gap: 8px; }
button { padding: 5px 14px; font-size: 12px; border: 1px solid #555; border-radius: 4px;
  background: #333; color: #ccc; cursor: pointer; }
button:hover { background: #444; }
button.primary { background: #007acc; border-color: #007acc; color: #fff; }
button.primary:hover { background: #0098ff; }
</style></head><body>
<h3>${title}</h3>
${label ? `<label>${label}</label>` : ""}
<input id="val" type="text" value="${defaultValue}" autofocus />
<div class="buttons">
  <button onclick="close_cancel()">Cancel</button>
  <button class="primary" onclick="close_ok()">OK</button>
</div>
<script>
const inp = document.getElementById("val");
inp.select();
inp.addEventListener("keydown", (e) => {
  if (e.key === "Enter") close_ok();
  if (e.key === "Escape") close_cancel();
});
function close_ok() {
  document.title = "OK:" + inp.value;
}
function close_cancel() {
  document.title = "CANCEL";
}
</script></body></html>`;

        win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

        let resolved = false;
        win.webContents.on("page-title-updated", (_ev, newTitle) => {
          if (resolved) return;
          resolved = true;
          if (newTitle.startsWith("OK:")) {
            resolve(newTitle.slice(3));
          } else {
            resolve(null);
          }
          win.close();
        });

        win.on("closed", () => {
          if (!resolved) {
            resolved = true;
            resolve(null);
          }
        });

        win.once("ready-to-show", () => win.show());
      });
    },
  );

  // Context menu
  ipcMain.handle(
    "context-menu:show",
    async (
      _event,
      items: Array<{
        id: string;
        label: string;
        enabled?: boolean;
      }>,
    ) => {
      const win = ctx.mainWindow();
      if (!win) return null;

      return new Promise<string | null>((resolve) => {
        const menu = Menu.buildFromTemplate(
          items.map((item) => {
            if (item.id === "separator") {
              return { type: "separator" as const };
            }
            return {
              label: item.label,
              enabled: item.enabled ?? true,
              click: () => resolve(item.id),
            };
          }),
        );
        menu.popup({
          window: win,
          callback: () => resolve(null),
        });
      });
    },
  );

  // Open external URL
  ipcMain.on(
    "shell:open-external",
    (_event, url: string) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    },
  );

  // Git replay
  if (!DISABLE_GIT_REPLAY) {
    gitReplay.setNotifyFn((msg) => {
      ctx.forwardToWebview(
        `viewer:${msg.workspacePath}`,
        "replay:data",
        msg,
      );
    });
  }

  ipcMain.handle(
    "replay:start",
    (
      _event,
      params: { workspacePath: string },
    ): boolean => {
      if (DISABLE_GIT_REPLAY) return false;
      return gitReplay.startReplay(params.workspacePath);
    },
  );

  ipcMain.handle("replay:stop", () => {
    if (DISABLE_GIT_REPLAY) return;
    gitReplay.stopReplay();
  });

  // Import web article
  ipcMain.handle(
    "import:web-article",
    async (_event, url: string, targetDir: string) => {
      const ws = ctx.getActiveWorkspacePath();
      if (!ws) {
        throw new Error("No active workspace");
      }
      const articleResult = await importWebArticle(
        url,
        targetDir,
        ws,
      );
      ctx.trackEvent("web_article_imported");
      return articleResult;
    },
  );

  // Agent activity
  agentActivity.setNotifyFn((event) => {
    ctx.forwardToWebview(
      "viewer",
      `agent:${event.kind}`,
      event,
    );
  });

  ipcMain.handle(
    "agent:focus-session",
    (_event, sessionId: string) => {
      const ptyId =
        agentActivity.getPtySessionId(sessionId);
      if (ptyId) {
        ctx.forwardToWebview(
          "terminal",
          "focus-tab",
          ptyId,
        );
      }
    },
  );

  // Viewer: run in terminal
  ipcMain.on(
    "viewer:run-in-terminal",
    (_event, command: string) => {
      ctx.forwardToWebview(
        "terminal",
        "run-in-terminal",
        command,
      );
    },
  );

  // JSON-RPC methods
  registerMethod(
    "agent.sessionStart",
    (params) => {
      const p = params as {
        session_id: string;
        cwd: string;
        pty_session_id?: string;
      };
      agentActivity.sessionStart(p);
      if (p.pty_session_id) {
        agentActivity.linkPtySession(
          p.session_id,
          p.pty_session_id,
        );
      }
      return { ok: true };
    },
    {
      description: "Register a new agent session",
      params: {
        session_id: "Unique session identifier",
        cwd: "Working directory of the agent",
        pty_session_id:
          "(optional) PTY session to link",
      },
    },
  );

  registerMethod(
    "agent.fileTouched",
    (params) => {
      const p = params as {
        session_id: string;
        tool_name: string;
        file_path: string | null;
      };
      agentActivity.fileTouched(p);
      return { ok: true };
    },
    {
      description:
        "Log a file read/write by an agent",
      params: {
        session_id: "Agent session identifier",
        tool_name: "Tool that accessed the file",
        file_path: "Absolute path to the file",
      },
    },
  );

  registerMethod(
    "agent.sessionEnd",
    (params) => {
      const p = params as { session_id: string };
      agentActivity.sessionEnd(p);
      return { ok: true };
    },
    {
      description: "End an agent session",
      params: {
        session_id: "Agent session identifier",
      },
    },
  );

  registerMethod(
    "app.notify",
    (params) => {
      const p = params as {
        title?: string;
        body: string;
      };
      const note = new Notification({
        title: p.title ?? "Collaborator",
        body: p.body,
      });
      note.show();
      return { ok: true };
    },
    {
      description: "Show a native macOS notification",
      params: {
        title:
          "(optional) Notification title, defaults to 'Collaborator'",
        body: "Notification body text",
      },
    },
  );
}
