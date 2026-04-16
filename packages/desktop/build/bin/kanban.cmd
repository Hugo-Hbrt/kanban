@echo off
REM Kanban CLI shim — bundled with the desktop app (Windows).
REM
REM Windows equivalent of `build/bin/kanban`. See that file for detailed
REM comments; this invokes node with the bundled CLI at Resources/cli/.

set "SCRIPT_DIR=%~dp0"
set "RESOURCES_DIR=%SCRIPT_DIR%.."
set "CLI_ENTRY=%RESOURCES_DIR%\cli\cli.js"

if not exist "%CLI_ENTRY%" (
  echo error: Kanban CLI not found at %CLI_ENTRY% >&2
  exit /b 1
)

node "%CLI_ENTRY%" %*
