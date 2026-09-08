#!/usr/bin/env bash
# Prepara o ambiente do ClipForge no Linux/macOS.
# Uso: bash scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "== ClipForge :: setup =="

# --- Python ---------------------------------------------------------------
command -v python3 >/dev/null || { echo "Python 3.10+ e necessario."; exit 1; }

VERSION=$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')
echo "Python $VERSION detectado."

if [ ! -d ".venv" ]; then
  echo "Criando ambiente virtual..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --upgrade pip --quiet
echo "Instalando dependencias Python (pode demorar alguns minutos)..."
pip install -r backend/requirements.txt

# --- .env -----------------------------------------------------------------
if [ ! -f ".env" ]; then
  cp .env.example .env
  echo ".env criado a partir do .env.example."
fi

# --- FFmpeg ---------------------------------------------------------------
if ! command -v ffmpeg >/dev/null; then
  echo "FFmpeg nao encontrado. Instale com: sudo apt install ffmpeg"
fi

# --- Frontend -------------------------------------------------------------
if command -v npm >/dev/null; then
  echo "Instalando dependencias do frontend..."
  (cd frontend && npm install)
else
  echo "Node.js nao encontrado; pulando o frontend."
fi

# --- Diagnostico ----------------------------------------------------------
echo
echo "== Diagnostico =="
python backend/cli.py doctor

echo
echo "Pronto. Ative a venv com: source .venv/bin/activate"
