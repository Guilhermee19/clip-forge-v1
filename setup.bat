@echo off
setlocal
title ClipForge :: instalacao
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
set "SETUP_EXIT=%ERRORLEVEL%"
echo.
if not "%SETUP_EXIT%"=="0" echo A instalacao nao foi concluida. Veja o erro acima.
if not defined CLIPFORGE_NONINTERACTIVE pause
exit /b %SETUP_EXIT%
