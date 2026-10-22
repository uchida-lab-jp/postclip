@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 goto :failed

where node >nul 2>&1
if errorlevel 1 goto :missing_node
where npm >nul 2>&1
if errorlevel 1 goto :missing_npm
where powershell.exe >nul 2>&1
if errorlevel 1 goto :missing_powershell

echo [1/4] Installing dependencies (npm ci)...
call npm ci
if errorlevel 1 goto :failed

echo [2/4] Running unit tests...
call npm test
if errorlevel 1 goto :failed

echo [3/4] Building Windows x64 executable...
call npm run build:win
if errorlevel 1 goto :failed

echo [4/4] Creating and verifying Windows release ZIP...
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0scripts\package-win.ps1"
if errorlevel 1 goto :failed

echo.
echo [OK] Windows release ZIP was created in dist.
endlocal & exit /b 0

:missing_node
echo [ERROR] Node.js is required. Install Node.js 22.12 or later.
goto :failed
:missing_npm
echo [ERROR] npm was not found.
goto :failed
:missing_powershell
echo [ERROR] Windows PowerShell was not found.
goto :failed
:failed
echo [ERROR] Build aborted. Do not distribute an older ZIP as this build.
endlocal & exit /b 1
