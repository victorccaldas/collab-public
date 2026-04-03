@echo off
REM ============================================================
REM  Build and package Collaborator from source (unsigned).
REM  Usage:  install.bat
REM ============================================================

cd /d "%~dp0collab-electron"

REM -- Check for running Collaborator processes --
tasklist /FI "IMAGENAME eq Collaborator.exe" 2>NUL | find /I "Collaborator.exe" >NUL
if %ERRORLEVEL% equ 0 (
    echo WARNING: Collaborator.exe is currently running.
    echo The build will fail if files are locked by a running instance.
    echo.
    set /p KILL_CHOICE="Kill all Collaborator processes? [Y/n] "
    if /I "%KILL_CHOICE%"=="" goto :kill_collab
    if /I "%KILL_CHOICE%"=="y" goto :kill_collab
    if /I "%KILL_CHOICE%"=="yes" goto :kill_collab
    echo Continuing without killing. Build may fail if files are locked.
    goto :start_build
)
goto :start_build

:kill_collab
echo Killing Collaborator processes...
taskkill /F /IM Collaborator.exe >NUL 2>&1
timeout /t 2 /nobreak >NUL
echo Done.

:start_build
echo [1/3] Installing dependencies...
call bun install
if %ERRORLEVEL% neq 0 (
    echo ERROR: bun install failed
    pause
    exit /b 1
)

echo [2/3] Building...
call bun run build
if %ERRORLEVEL% neq 0 (
    echo ERROR: build failed
    pause
    exit /b 1
)

echo [3/3] Packaging (unsigned)...
call bun run package:unsigned
if %ERRORLEVEL% neq 0 (
    echo ERROR: packaging failed
    pause
    exit /b 1
)

echo.
echo Done!
set /p RUN_CHOICE="Launch Collaborator now? [Y/n] "
if /I "%RUN_CHOICE%"=="" goto :launch
if /I "%RUN_CHOICE%"=="y" goto :launch
if /I "%RUN_CHOICE%"=="yes" goto :launch
goto :eof

:launch
start "" "%~dp0collab-electron\dist\win-unpacked\Collaborator.exe"
