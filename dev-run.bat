@echo off
REM ============================================================
REM  Run Collaborator in dev mode (hot reload, no packaging).
REM  Usage:  dev-run.bat
REM ============================================================

cd /d "%~dp0collab-electron"

call bun run dev
pause
