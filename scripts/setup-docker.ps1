[CmdletBinding()]
param([switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host '== ClipForge :: Docker (CPU) ==' -ForegroundColor Cyan
    if (-not (Get-Command docker.exe -ErrorAction SilentlyContinue)) {
        $url = 'https://docs.docker.com/desktop/setup/install/windows-install/'
        Write-Host "Instale o Docker Desktop: $url"
        if (-not $NonInteractive) { Start-Process $url }
        throw 'Depois de instalar, abra o Docker Desktop com containers Linux e execute setup.bat --docker novamente.'
    }
    & docker.exe compose version
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose indisponivel. Atualize o Docker Desktop.' }
    & docker.exe info --format '{{.OSType}}' | Tee-Object -Variable dockerOS
    if ($LASTEXITCODE -ne 0) { throw 'Abra o Docker Desktop, aguarde o engine iniciar e execute novamente.' }
    if ($dockerOS -ne 'linux') { throw 'Selecione Linux containers no Docker Desktop e execute novamente.' }
    Write-Host 'Construindo as imagens e iniciando os containers. O primeiro download pode demorar.'
    & docker.exe compose up --build --detach --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) {
        throw 'Falha ao iniciar. Consulte docker compose logs e repita. Os dados existentes foram preservados.'
    }
    Write-Host 'Containers prontos. Portas publicadas:' -ForegroundColor Green
    & docker.exe compose port web 80
    & docker.exe compose port backend 8000
    Write-Host 'Padrao: http://localhost:5173 | API: http://localhost:8000/docs'
    Write-Host 'Modelo LLM opcional: docker compose exec ollama ollama pull llama3.1:8b-instruct-q4_K_M'
    Write-Host 'Parar: docker compose down | Logs: docker compose logs -f'
    Write-Host 'Tutorial: docs/instalacao-docker.md'
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
} finally { Pop-Location }
