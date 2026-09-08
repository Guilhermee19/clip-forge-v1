@echo off
rem ===========================================================================
rem  ClipForge - encerra os servicos abertos pelo start.bat.
rem
rem  Encerra por PORTA, e nao por titulo de janela: `taskkill /fi WINDOWTITLE`
rem  reporta sucesso mesmo quando nao encontra nada, o que dava um falso "ok".
rem  Quem estiver escutando na porta da API e na do Vite e derrubado junto com
rem  seus filhos, sem tocar em outros Python/Node da maquina.
rem ===========================================================================

setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title ClipForge :: stop

set "ROOT=%~dp0"
cd /d "%ROOT%"

set "API_PORT=8000"
set "WEB_PORT=5173"
if exist ".env" (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in ("%ROOT%.env") do (
        if /i "%%A"=="API_PORT" set "API_PORT=%%B"
    )
)

echo.
echo   Encerrando o ClipForge...
echo.

call :kill_port %API_PORT% "API"
call :kill_port %WEB_PORT% "UI "

rem Fecha as janelas de console que sobraram, agora vazias.
taskkill /f /fi "WINDOWTITLE eq ClipForge API*" >nul 2>&1
taskkill /f /fi "WINDOWTITLE eq ClipForge Web*" >nul 2>&1

echo.
ping -n 3 127.0.0.1 >nul
exit /b 0

rem ---------------------------------------------------------------------------
rem  :kill_port <porta> <rotulo>
rem  Mata a arvore de processos que escuta na porta indicada.
rem ---------------------------------------------------------------------------
:kill_port
set "PORT=%~1"
set "LABEL=%~2"
set "FOUND="

rem Sem `-p tcp`: o Vite escuta em IPv6 ^([::1]:5173^), que aquele filtro omite.
rem O espaco depois da porta evita casar 5173 com algo como 15173.
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /c:"LISTENING" ^| findstr /c:":%PORT% "') do (
    if not "%%P"=="0" (
        taskkill /f /t /pid %%P >nul 2>&1
        set "FOUND=1"
    )
)

if defined FOUND (
    echo   [ok]  %LABEL% encerrada na porta %PORT%
) else (
    echo   [--]  %LABEL% nao estava rodando na porta %PORT%
)
exit /b 0
