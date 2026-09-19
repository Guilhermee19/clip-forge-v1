#!/usr/bin/env bash
# Prepara o ambiente do ClipForge no Linux/macOS.
# Uso: bash scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== ClipForge :: setup =="

for tool in node npm git ffmpeg ffprobe; do
  command -v "$tool" >/dev/null || { echo "Instale $tool antes de continuar. Veja docs/instalacao-linux-macos.md"; exit 1; }
done
node -e 'process.exit(parseInt(process.versions.node) >= 22 ? 0 : 1)' || {
  echo "Node.js 22+ e necessario."
  exit 1
}

# --- Python ---------------------------------------------------------------
PYTHON=python3.10
command -v "$PYTHON" >/dev/null || PYTHON=python3
command -v "$PYTHON" >/dev/null || { echo "Instale Python 3.10. Veja docs/instalacao-linux-macos.md"; exit 1; }

VERSION=$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "Python $VERSION detectado."

if [[ "$VERSION" != "3.10" ]]; then
  echo "Python 3.10.x e necessario (versao do projeto: 3.10.11)."
  exit 1
fi

if [ ! -d ".venv" ]; then
  echo "Criando ambiente virtual..."
  "$PYTHON" -m venv .venv
fi

if ! .venv/bin/python -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 10) else 1)'; then
  echo "A .venv existente e incompativel. Renomeie-a como backup e execute novamente."
  exit 1
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip --quiet
echo "Instalando dependencias Python (pode demorar alguns minutos)..."
USE_CUDA=false
if [[ "$(uname -s)" == "Linux" ]] && command -v nvidia-smi >/dev/null && nvidia-smi >/dev/null 2>&1; then
  USE_CUDA=true
fi
if $USE_CUDA; then
  pip install -r backend/requirements.txt
else
  CPU_REQUIREMENTS=$(mktemp)
  trap 'rm -f -- "$CPU_REQUIREMENTS"' EXIT
  sed '/^nvidia-/d' backend/requirements.txt > "$CPU_REQUIREMENTS"
  pip install -r "$CPU_REQUIREMENTS"
fi
python -m pip install 'ruff>=0.8' 'pytest>=8.3'
python -m pip check

# --- .env -----------------------------------------------------------------
if [ ! -f ".env" ]; then
  cp .env.example .env
  if ! $USE_CUDA; then
    python - <<'PY'
from pathlib import Path
import re
path = Path('.env')
config = path.read_text(encoding='utf-8')
for key, value in {
    'WHISPER_MODEL': 'small',
    'WHISPER_DEVICE': 'cpu',
    'WHISPER_COMPUTE_TYPE': 'int8',
    'VIDEO_ENCODER': 'libx264',
}.items():
    config = re.sub(rf'^{key}=.*$', f'{key}={value}', config, flags=re.MULTILINE)
path.write_text(config, encoding='utf-8')
PY
  fi
  echo ".env criado a partir do .env.example."
else
  echo ".env preservado. Confira as opcoes de CPU/GPU conforme docs/instalacao-linux-macos.md."
fi

# --- Frontend -------------------------------------------------------------
echo "Instalando dependencias do frontend..."
(cd frontend && npm ci && npm run build)

# --- Diagnostico ----------------------------------------------------------
echo
echo "== Diagnostico =="
python backend/cli.py doctor

echo
echo "Pronto. Ative a venv com: source .venv/bin/activate"
