@echo off
REM Kanban CLI shim — bundled with the desktop app (Windows).
REM
REM Windows equivalent of `build/bin/kanban`. See that file for detailed
REM comments; this invokes node with the bundled CLI at
REM resources\app.asar.unpacked\cli\cli.js.
REM
REM `setlocal` scopes the SCRIPT_DIR / RESOURCES_DIR / CLI_ENTRY variables
REM to this batch file so they don't leak into the caller's cmd session.

setlocal

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "CLI_ENTRY=%RESOURCES_DIR%\app.asar.unpacked\cli\cli.js"

if not exist "%CLI_ENTRY%" (
  echo error: Kanban CLI not found at %CLI_ENTRY% >&2
  endlocal
  exit /b 1
)

node "%CLI_ENTRY%" %*
endlocal
