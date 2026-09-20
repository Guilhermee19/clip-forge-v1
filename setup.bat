@echo off
setlocal
title ClipForge :: instalacao
cd /d "%~dp0"
rem Argumentos existentes continuam executando o setup Windows diretamente.
if /i "%~1"=="--linux" goto linux
if /i "%~1"=="--macos" goto macos
if /i "%~1"=="--docker" goto docker
if not "%~1"=="" goto windows
if defined CLIPFORGE_NONINTERACTIVE goto windows

:menu
echo.
echo   ClipForge - escolha o sistema de destino
echo.
echo   [1] Windows - instalar neste computador
echo   [2] Linux   - instrucoes para o terminal Linux
echo   [3] macOS   - instrucoes para o terminal do Mac
echo   [4] Docker  - rodar tudo em containers
echo   [5] Sair
echo.
choice /c 12345 /n /m "Escolha [1-5]: "
if errorlevel 5 exit /b 0
if errorlevel 4 goto docker
if errorlevel 3 goto macos
if errorlevel 2 goto linux
if errorlevel 1 goto windows
exit /b 1

:linux
echo.
echo   LINUX
echo   Este .bat funciona no Windows. No Linux, abra o Terminal.
echo   Tenha Python 3.10, Node.js 22+, Git, FFmpeg e ffprobe instalados.
echo   Entre na pasta do projeto e execute:
echo.
echo     bash scripts/setup.sh
echo.
echo   Para iniciar depois da instalacao:
echo     bash start.sh
echo.
echo   Guia: docs/instalacao-linux-macos.md
goto instructions_done

:macos
echo.
echo   MACOS
echo   Este .bat funciona no Windows. No Mac, abra o Terminal.
echo   Tenha Python 3.10, Node.js 22+, Git, FFmpeg e ffprobe instalados.
echo   Entre na pasta do projeto e execute:
echo.
echo     bash scripts/setup.sh
echo.
echo   O setup do Mac usa CPU, sem bibliotecas CUDA da Nvidia.
echo   Para iniciar depois da instalacao:
echo     bash start.sh
echo.
echo   Guia: docs/instalacao-linux-macos.md
goto instructions_done

:instructions_done
echo   Nenhum programa foi instalado no Windows por esta opcao.
if not defined CLIPFORGE_NONINTERACTIVE pause
exit /b 0

:windows
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup.ps1" %*
goto finish

:docker
set "DOCKER_ARGS="
if defined CLIPFORGE_NONINTERACTIVE set "DOCKER_ARGS=-NonInteractive"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-docker.ps1" %DOCKER_ARGS%

:finish
set "SETUP_EXIT=%ERRORLEVEL%"
echo.
if not "%SETUP_EXIT%"=="0" echo A instalacao nao foi concluida. Veja o erro acima.
if not defined CLIPFORGE_NONINTERACTIVE pause
exit /b %SETUP_EXIT%
