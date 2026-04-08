import { spawn } from "node:child_process";
import { join } from "node:path";

const repoDir = process.cwd();

// Raise V8 heap limit for the dev server / Electron main process
process.env.NODE_OPTIONS = "--max-old-space-size=12288";

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
