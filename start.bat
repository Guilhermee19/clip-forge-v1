@echo off
rem ===========================================================================
rem  ClipForge - inicia backend (API + WebSocket) e frontend (UI) de uma vez.
rem
rem  Uso: duplo-clique neste arquivo, ou `start.bat` no terminal.
rem
rem  Abre duas janelas de console, uma para cada servico, e o navegador na UI.
rem  Para parar tudo: feche as duas janelas, ou rode `stop.bat`.
rem ===========================================================================

setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title ClipForge :: launcher

set "ROOT=%~dp0"
cd /d "%ROOT%"

echo.
echo   ClipForge
echo   ---------
echo.

rem --------------------------------------------------------------------------
rem  1. Configuracao
rem --------------------------------------------------------------------------
if not exist ".env" (
    if exist ".env.example" (
        copy /y ".env.example" ".env" >nul
        echo   [ok]  .env criado a partir do .env.example
    ) else (
        echo   [!!]  .env.example nao encontrado.
        goto :fail
    )
)

rem Le as portas do .env. `eol=#` faz o for ignorar as linhas de comentario.
set "API_PORT=8000"
set "WEB_PORT=5173"
for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%.env") do (
    if /i "%%A"=="API_PORT" set "API_PORT=%%B"
)

rem --------------------------------------------------------------------------
rem  2. Ambiente Python
rem --------------------------------------------------------------------------
set "VENV_PY=%ROOT%.venv\Scripts\python.exe"

if not exist "%VENV_PY%" (
    echo   [!!]  Ambiente virtual nao encontrado em .venv
    echo.
    echo         Rode o setup primeiro:
    echo           powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
    goto :fail
)

"%VENV_PY%" -c "import fastapi, uvicorn" >nul 2>&1
if errorlevel 1 (
    echo   [!!]  Dependencias Python faltando na .venv
    echo.
    echo         Instale com:
    echo           .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
    goto :fail
)
echo   [ok]  Python e dependencias do backend

rem --------------------------------------------------------------------------
rem  3. FFmpeg
rem --------------------------------------------------------------------------
where ffmpeg >nul 2>&1
if errorlevel 1 (
    echo   [!!]  FFmpeg nao encontrado no PATH. Instale com:
    echo           winget install Gyan.FFmpeg
    echo         A API sobe, mas nenhum corte sera renderizado.
) else (
    echo   [ok]  FFmpeg
)

rem --------------------------------------------------------------------------
rem  4. Frontend
rem --------------------------------------------------------------------------
where npm >nul 2>&1
if errorlevel 1 (
    echo   [!!]  Node.js nao encontrado. Apenas a API sera iniciada.
    set "SKIP_WEB=1"
) else (
    if not exist "frontend\node_modules" (
        echo   [..]  Instalando dependencias do frontend, isso leva um minuto...
        pushd "%ROOT%frontend"
        call npm install --no-fund --no-audit
        popd
        if errorlevel 1 (
            echo   [!!]  npm install falhou.
            goto :fail
        )
    )
    echo   [ok]  Frontend
)

rem --------------------------------------------------------------------------
rem  5. Sobe os servicos
rem --------------------------------------------------------------------------
echo.
echo   Iniciando a API em http://127.0.0.1:%API_PORT% ...
start "ClipForge API" cmd /k "%VENV_PY%" backend\cli.py serve

if not defined SKIP_WEB (
    echo   Iniciando a UI  em http://localhost:%WEB_PORT% ...
    start "ClipForge Web" /d "%ROOT%frontend" cmd /k npm run dev
)

rem Espera a API responder antes de abrir o navegador, para nao cair numa
rem tela de erro enquanto o Python ainda esta carregando.
set /a tries=0
:wait_api
set /a tries+=1
curl -s -f -o nul "http://127.0.0.1:%API_PORT%/api/health" >nul 2>&1
if not errorlevel 1 goto :api_up
if !tries! geq 40 goto :api_slow
ping -n 2 127.0.0.1 >nul
goto :wait_api

:api_up
echo   [ok]  API respondendo.
goto :open_browser

:api_slow
echo   [!!]  A API demorou a responder. Veja a janela "ClipForge API".
goto :open_browser

:open_browser
if not defined SKIP_WEB (
    rem O Vite precisa de mais alguns segundos para o primeiro bundle.
    ping -n 4 127.0.0.1 >nul
    start "" "http://localhost:%WEB_PORT%"
)

echo.
echo   Tudo no ar.
echo     UI    http://localhost:%WEB_PORT%
echo     API   http://127.0.0.1:%API_PORT%/docs
echo     Saida %ROOT%output\clips
echo.
echo   Para parar: feche as duas janelas, ou rode stop.bat
echo.
ping -n 9 127.0.0.1 >nul
exit /b 0

:fail
echo.
if not defined CLIPFORGE_NONINTERACTIVE (
    echo   Pressione qualquer tecla para fechar...
    pause >nul
)
exit /b 1
