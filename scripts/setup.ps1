<# Prepara o ClipForge no Windows. Uso: .\setup.bat [-Device cpu] [-NonInteractive] #>
[CmdletBinding()]
param(
    [ValidateSet('auto', 'cpu', 'cuda')][string]$Device = 'auto',
    [switch]$InstallOllama,
    [switch]$InstallVSCode,
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "Falha ao executar $File (codigo $LASTEXITCODE). Corrija o erro acima e rode setup.bat novamente."
    }
}

function Install-Prerequisite {
    param([string]$Id, [string]$Url)
    Write-Host "Instalando $Id... O Windows pode solicitar permissao." -ForegroundColor Yellow
    if (Get-Command winget.exe -ErrorAction SilentlyContinue) {
        & winget.exe install --id $Id --exact --source winget --architecture x64 --accept-package-agreements --accept-source-agreements | Out-Host
        $installCode = $LASTEXITCODE
        $env:PATH = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + $env:PATH
        if ($installCode -eq 0) { return }
        Write-Host "WinGet retornou $installCode." -ForegroundColor Yellow
    }
    Write-Host "Baixe e instale em: $Url" -ForegroundColor Yellow
    if (-not $NonInteractive) { Start-Process $Url }
    throw "Instale $Id pelo link acima, abra um novo terminal e execute setup.bat novamente."
}

function Test-ProjectPython {
    param([string]$Candidate)
    if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate -PathType Leaf)) { return $false }
    try {
        & $Candidate -c "import sys, struct; sys.exit(0 if sys.version_info[:2] == (3, 10) and struct.calcsize('P') == 8 else 1)" 2>$null | Out-Null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

function Find-ProjectPython {
    $candidates = @((Join-Path $root '.venv\Scripts\python.exe'))
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
        try {
            $detected = & py.exe -3.10 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0) { $candidates += $detected }
        } catch { }
    }
    $candidates += @("$env:LOCALAPPDATA\Programs\Python\Python310\python.exe", "$env:ProgramFiles\Python310\python.exe")
    $candidates += @(Get-Command python.exe -All -ErrorAction SilentlyContinue |
        Where-Object { $_.Source -notlike '*\WindowsApps\*' } | Select-Object -ExpandProperty Source)
    foreach ($candidate in $candidates) {
        if (Test-ProjectPython $candidate) { return $candidate }
    }
    return $null
}

function Test-Node {
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $false }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { return $false }
    & node.exe -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' | Out-Null
    return ($LASTEXITCODE -eq 0)
}

function Ask-Optional {
    param([string]$Question)
    if ($NonInteractive) { return $false }
    return ((Read-Host "$Question [s/N]") -match '^(s|sim|y|yes)$')
}

Push-Location $root
try {
    Write-Host '== ClipForge :: instalacao para desenvolvimento ==' -ForegroundColor Cyan
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -ne 'AMD64') {
        throw "Arquitetura $architecture nao suportada por este instalador. Use Windows x64 (Intel/AMD) para estas dependencias."
    }
    Write-Host 'Internet necessaria. Bibliotecas de GPU e modelos podem ocupar varios GB.'
    Write-Host "`n[1/6] Python 3.10 x64" -ForegroundColor Cyan
    $python = Find-ProjectPython
    if (-not $python) {
        Install-Prerequisite 'Python.Python.3.10' 'https://www.python.org/downloads/release/python-31011/'
        $python = Find-ProjectPython
        if (-not $python) { throw 'Python 3.10 x64 ainda nao encontrado. Reabra o terminal e rode setup.bat.' }
    }
    Write-Host "Python selecionado: $python"

    Write-Host "`n[2/6] Node.js, Git e FFmpeg" -ForegroundColor Cyan
    if (-not (Test-Node)) {
        Install-Prerequisite 'OpenJS.NodeJS.LTS' 'https://nodejs.org/en/download'
        if (-not (Test-Node)) { throw 'Node.js 22+ e npm ainda nao encontrados. Reabra o terminal e rode setup.bat.' }
    }
    if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
        Install-Prerequisite 'Git.Git' 'https://git-scm.com/downloads/win'
    }
    if (-not (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue) -or
        -not (Get-Command ffprobe.exe -ErrorAction SilentlyContinue)) {
        Install-Prerequisite 'Gyan.FFmpeg' 'https://www.gyan.dev/ffmpeg/builds/'
    }
    foreach ($command in @('git.exe', 'ffmpeg.exe', 'ffprobe.exe')) {
        if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
            throw "$command ainda nao encontrado no PATH. Reabra o terminal e rode setup.bat."
        }
    }
    Invoke-Checked 'git.exe' @('--version')
    Invoke-Checked 'ffmpeg.exe' @('-version')
    Invoke-Checked 'ffprobe.exe' @('-version')

    Write-Host "`n[3/6] Hardware e ambiente virtual" -ForegroundColor Cyan
    $hasNvidia = $false
    if (Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue) {
        try {
            $gpuInfo = & nvidia-smi.exe --query-gpu=name,memory.total --format=csv,noheader 2>$null
            $hasNvidia = ($LASTEXITCODE -eq 0 -and [bool]$gpuInfo)
            if ($hasNvidia) { Write-Host "GPU: $gpuInfo" }
        } catch { Write-Host 'Driver Nvidia indisponivel; deteccao automatica usara CPU.' }
    }
    if ($Device -eq 'auto') {
        if ($hasNvidia) { $Device = 'cuda' } else { $Device = 'cpu' }
    }
    if ($Device -eq 'cuda' -and -not $hasNvidia) {
        throw 'CUDA solicitado, mas nvidia-smi nao detectou uma GPU. Instale o driver Nvidia ou use setup.bat -Device cpu.'
    }
    Write-Host "Modo de instalacao: $Device"
    $venv = Join-Path $root '.venv'
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    if ((Test-Path -LiteralPath $venv) -and -not (Test-ProjectPython $venvPython)) {
        $venvItem = Get-Item -LiteralPath $venv
        if ($venvItem.FullName -ne $venv -or ($venvItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'A .venv e um link ou possui caminho inesperado. Ajuste-a manualmente antes de continuar.'
        }
        $backup = Join-Path $root ('.venv-backup-' + [guid]::NewGuid().ToString('N'))
        if ((Split-Path -Parent $backup) -ne $root) { throw 'Caminho de backup fora do projeto.' }
        Move-Item -LiteralPath $venv -Destination $backup
        Write-Host "Ambiente antigo preservado em $backup"
    }
    if (-not (Test-Path -LiteralPath $venvPython)) { Invoke-Checked $python @('-m', 'venv', $venv) }
    if (-not (Test-ProjectPython $venvPython)) { throw 'A .venv criada nao usa Python 3.10 x64.' }
    Invoke-Checked $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
    $requirements = Join-Path $root 'backend\requirements.txt'
    $temporaryRequirements = $null
    try {
        if ($Device -eq 'cpu') {
            $temporaryRequirements = [IO.Path]::GetTempFileName()
            Get-Content -LiteralPath $requirements | Where-Object { $_ -notmatch '^nvidia-' } |
                Set-Content -LiteralPath $temporaryRequirements -Encoding UTF8
            $requirements = $temporaryRequirements
        }
        Invoke-Checked $venvPython @('-m', 'pip', 'install', '--prefer-binary', '-r', $requirements)
        Invoke-Checked $venvPython @('-m', 'pip', 'install', 'ruff>=0.8', 'pytest>=8.3')
        Invoke-Checked $venvPython @('-m', 'pip', 'check')
    } finally {
        if ($temporaryRequirements) { Remove-Item -LiteralPath $temporaryRequirements }
    }

    Write-Host "`n[4/6] Configuracao e frontend" -ForegroundColor Cyan
    $envFile = Join-Path $root '.env'
    if (-not (Test-Path -LiteralPath $envFile)) {
        $config = [IO.File]::ReadAllText((Join-Path $root '.env.example'))
        if ($Device -eq 'cpu') {
            $config = $config -replace '(?m)^WHISPER_MODEL=.*$', 'WHISPER_MODEL=small'
            $config = $config -replace '(?m)^WHISPER_DEVICE=.*$', 'WHISPER_DEVICE=cpu'
            $config = $config -replace '(?m)^WHISPER_COMPUTE_TYPE=.*$', 'WHISPER_COMPUTE_TYPE=int8'
            $config = $config -replace '(?m)^VIDEO_ENCODER=.*$', 'VIDEO_ENCODER=libx264'
        }
        [IO.File]::WriteAllText($envFile, $config, (New-Object Text.UTF8Encoding $false))
    } else {
        Write-Host '.env existente preservado. Confira WHISPER_DEVICE, WHISPER_MODEL e VIDEO_ENCODER conforme o hardware.'
    }
    Push-Location (Join-Path $root 'frontend')
    try {
        Invoke-Checked 'npm.cmd' @('ci')
        Invoke-Checked 'npm.cmd' @('run', 'build')
    } finally { Pop-Location }

    Write-Host "`n[5/6] Ferramentas opcionais" -ForegroundColor Cyan
    if ($InstallVSCode -or (Ask-Optional 'Instalar/verificar o VS Code para editar o projeto?')) {
        if (-not (Get-Command code.cmd -ErrorAction SilentlyContinue)) {
            Install-Prerequisite 'Microsoft.VisualStudioCode' 'https://code.visualstudio.com/download'
        }
    }
    if ($InstallOllama -or (Ask-Optional 'Instalar Ollama e baixar o modelo local (varios GB)?')) {
        if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) {
            Install-Prerequisite 'Ollama.Ollama' 'https://ollama.com/download/windows'
        }
        if (-not (Get-Command ollama.exe -ErrorAction SilentlyContinue)) {
            throw 'Reabra o terminal e execute setup.bat -InstallOllama para concluir o modelo.'
        }
        try { Invoke-RestMethod 'http://localhost:11434/api/tags' -TimeoutSec 5 | Out-Null }
        catch {
            Start-Process -FilePath (Get-Command ollama.exe).Source -ArgumentList 'serve' -WindowStyle Hidden
            $ready = $false
            for ($attempt = 0; $attempt -lt 15; $attempt++) {
                Start-Sleep -Seconds 1
                try {
                    Invoke-RestMethod 'http://localhost:11434/api/tags' -TimeoutSec 2 | Out-Null
                    $ready = $true
                    break
                } catch { }
            }
            if (-not $ready) { throw 'Ollama nao iniciou. Abra o Ollama e rode setup.bat -InstallOllama novamente.' }
        }
        Invoke-Checked 'ollama.exe' @('pull', 'llama3.1:8b-instruct-q4_K_M')
    }

    Write-Host "`n[6/6] Diagnostico" -ForegroundColor Cyan
    Invoke-Checked $venvPython @((Join-Path $root 'backend\cli.py'), 'doctor')
    Write-Host "`nAmbiente instalado. Confira os avisos do diagnostico acima." -ForegroundColor Green
    Write-Host 'Feche este terminal e abra outro para carregar o PATH dos programas instalados.'
    Write-Host 'Iniciar: .\start.bat | Parar: .\stop.bat'
    Write-Host 'VS Code: abra esta pasta e selecione .venv\Scripts\python.exe como interpretador.'
    Write-Host 'Tutorial completo: docs\instalacao-windows.md'
} catch {
    Write-Host "`nInstalacao interrompida: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally { Pop-Location }
