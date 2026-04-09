$ErrorActionPreference = "Stop"

$repoDir = Split-Path -Parent $PSScriptRoot
$electronPath = Join-Path $repoDir "node_modules\electron\dist\electron.exe"
$electronVitePath = Join-Path $repoDir "node_modules\.bin\electron-vite.exe"

Get-Process -Name electron -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $electronPath } |
  ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }

Get-Process -Name electron-vite -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -like "$repoDir*" } |
  ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }

Start-Sleep -Milliseconds 500

# V8 heap tuning for the Electron main process.
#
# IMPORTANT: Electron 40's embedded V8 silently caps --max-old-space-size
# at 4096 MB — values above that are ignored (regular Node.js has no such
# cap). The only way to get extra headroom is --max-semi-space-size which
# adds ~2× its value on top of the old-space cap (256 → ~512 MB extra).
#
# --expose-gc enables globalThis.gc() so the memory watchdog can force
# garbage collection when heap pressure is detected.
$env:NODE_OPTIONS = "--max-old-space-size=4096 --max-semi-space-size=256 --expose-gc"

& $electronVitePath dev
exit $LASTEXITCODE
