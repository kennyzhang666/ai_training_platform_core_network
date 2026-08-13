@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "PLATFORM_UPGRADE_ROOT=%~dp0"
set "PLATFORM_UPGRADE_PWSH=%PLATFORM_UPGRADE_ROOT%runtime\powershell\pwsh.exe"
set "PLATFORM_UPGRADE_SCRIPT=%PLATFORM_UPGRADE_ROOT%deploy\single-node\upgrade.ps1"

if not exist "%PLATFORM_UPGRADE_PWSH%" (
  echo The complete offline package is missing runtime\powershell\pwsh.exe. 1>&2
  exit /b 1
)

if not exist "%PLATFORM_UPGRADE_SCRIPT%" (
  echo The complete offline package is missing deploy\single-node\upgrade.ps1. 1>&2
  exit /b 1
)

"%PLATFORM_UPGRADE_PWSH%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PLATFORM_UPGRADE_SCRIPT%" %*
exit /b %ERRORLEVEL%
