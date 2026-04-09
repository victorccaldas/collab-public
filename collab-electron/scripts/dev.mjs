import { spawn } from "node:child_process";
import { join } from "node:path";

const repoDir = process.cwd();

// V8 heap tuning for the Electron main process.
//
// IMPORTANT: Electron 40's embedded V8 silently caps --max-old-space-size
// at 4096 MB — values above that are ignored (regular Node.js has no such
// cap). The only way to get extra headroom is --max-semi-space-size which
// adds ~2× its value on top of the old-space cap (256 → ~512 MB extra).
//
// --expose-gc enables globalThis.gc() so the memory watchdog can force
// garbage collection when heap pressure is detected.
process.env.NODE_OPTIONS = "--max-old-space-size=4096 --max-semi-space-size=256 --expose-gc";

const child = process.platform === "win32"
  ? spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(repoDir, "scripts", "dev.ps1"),
      ],
      { stdio: "inherit", cwd: repoDir },
    )
  : spawn(process.execPath, ["x", "electron-vite", "dev"], {
      stdio: "inherit",
      cwd: repoDir,
    });

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on("SIGINT", forwardSignal);
process.on("SIGTERM", forwardSignal);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
