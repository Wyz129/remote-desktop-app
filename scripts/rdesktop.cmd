@echo off
setlocal
if exist "%~dp0..\..\..\Remote Desktop.exe" goto packaged
node "%~dp0cli.cjs" %*
exit /b %errorlevel%
:packaged
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\Remote Desktop.exe" "%~dp0cli.cjs" %*
exit /b %errorlevel%
