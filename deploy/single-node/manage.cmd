@echo off
setlocal
set "PLATFORM_DEPLOY_ROOT=%~dp0"
set "PLATFORM_PWSH=%PLATFORM_DEPLOY_ROOT%..\..\runtime\powershell\pwsh.exe"
if not exist "%PLATFORM_PWSH%" (
  echo 发布包内缺少 PowerShell 运行时：%PLATFORM_PWSH% 1>&2
  exit /b 1
)
"%PLATFORM_PWSH%" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%PLATFORM_DEPLOY_ROOT%manage.ps1" %*
exit /b %ERRORLEVEL%
