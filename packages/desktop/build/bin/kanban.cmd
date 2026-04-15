@echo off
REM Kanban CLI shim — bundled with the desktop app (Windows).
REM
REM Windows equivalent of the bash shim.  Uses node from PATH to run
REM the CLI entry point bundled inside the app's resources.

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "CLI_ENTRY=%RESOURCES_DIR%\app.asar.unpacked\node_modules\kanban\dist\cli.js"

if not exist "%CLI_ENTRY%" (
  echo error: Kanban CLI not found at %CLI_ENTRY% >&2
  exit /b 1
)

node "%CLI_ENTRY%" %*
