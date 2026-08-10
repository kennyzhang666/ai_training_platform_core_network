@echo off
setlocal
call "%~dp0deploy\single-node\manage.cmd" Install %*
exit /b %ERRORLEVEL%
