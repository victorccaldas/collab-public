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

# Raise V8 heap limit for the dev server / Electron main process
$env:NODE_OPTIONS = "--max-old-space-size=12288"

& $electronVitePath dev
exit $LASTEXITCODE
