<#
.SYNOPSIS
    Prepara o ambiente do ClipForge no Windows.
.DESCRIPTION
    Cria a venv, instala as dependencias Python e do frontend, copia o .env e
    roda o diagnostico. Idempotente: pode rodar de novo sem problema.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#>

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

Write-Host "== ClipForge :: setup ==" -ForegroundColor Cyan

# --- Python ---------------------------------------------------------------
$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) { throw "Python 3.10+ nao encontrado no PATH." }

$version = (python -c "import sys; print('%d.%d' % sys.version_info[:2])")
Write-Host "Python $version detectado." -ForegroundColor Gray
if ([version]$version -lt [version]"3.10") { throw "Python 3.10 ou superior e necessario." }

$venv = Join-Path $root ".venv"
if (-not (Test-Path $venv)) {
    Write-Host "Criando ambiente virtual..." -ForegroundColor Yellow
    python -m venv $venv
}

$venvPython = Join-Path $venv "Scripts\python.exe"
& $venvPython -m pip install --upgrade pip --quiet
Write-Host "Instalando dependencias Python (pode demorar alguns minutos)..." -ForegroundColor Yellow
& $venvPython -m pip install -r (Join-Path $root "backend\requirements.txt")

# --- .env -----------------------------------------------------------------
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $root ".env.example") $envFile
    Write-Host ".env criado a partir do .env.example." -ForegroundColor Green
}

# --- FFmpeg ---------------------------------------------------------------
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host "FFmpeg nao encontrado. Instale com: winget install Gyan.FFmpeg" -ForegroundColor Yellow
}

# --- Frontend -------------------------------------------------------------
if (Get-Command npm -ErrorAction SilentlyContinue) {
    Write-Host "Instalando dependencias do frontend..." -ForegroundColor Yellow
    Push-Location (Join-Path $root "frontend")
    npm install
    Pop-Location
} else {
    Write-Host "Node.js nao encontrado; pulando o frontend." -ForegroundColor Yellow
}

# --- Diagnostico ----------------------------------------------------------
Write-Host "`n== Diagnostico ==" -ForegroundColor Cyan
& $venvPython (Join-Path $root "backend\cli.py") doctor

Write-Host "`nPronto. Ative a venv com: .venv\Scripts\activate" -ForegroundColor Green
