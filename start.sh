#!/usr/bin/env bash
# ===========================================================================
#  ClipForge - inicia backend (API + WebSocket) e frontend (UI) de uma vez.
#
#  Uso: ./start.sh          ou    bash start.sh
#
#  Diferente do .bat, aqui os dois servicos rodam como filhos deste script:
#  um Ctrl+C derruba tudo junto.
# ===========================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo
echo "  ClipForge"
echo "  ---------"
echo

fail() {
  echo "  [!!]  $1" >&2
  exit 1
}

# --------------------------------------------------------------------------
#  1. Configuracao
# --------------------------------------------------------------------------
if [ ! -f ".env" ]; then
  [ -f ".env.example" ] || fail ".env.example nao encontrado."
  cp .env.example .env
  echo "  [ok]  .env criado a partir do .env.example"
fi

# Le as portas do .env sem dar source no arquivo inteiro.
API_PORT="$(grep -E '^API_PORT=' .env | tail -1 | cut -d= -f2 | tr -d '[:space:]')"
WEB_PORT=5173
: "${API_PORT:=8000}"

# --------------------------------------------------------------------------
#  2. Ambiente Python
# --------------------------------------------------------------------------
VENV_PY="$ROOT/.venv/bin/python"
[ -x "$VENV_PY" ] || fail "Ambiente virtual nao encontrado. Rode: bash scripts/setup.sh"

"$VENV_PY" -c "import fastapi, uvicorn" 2>/dev/null ||
  fail "Dependencias faltando. Rode: .venv/bin/pip install -r backend/requirements.txt"
echo "  [ok]  Python e dependencias do backend"

# --------------------------------------------------------------------------
#  3. FFmpeg
# --------------------------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  [ok]  FFmpeg"
else
  echo "  [!!]  FFmpeg ausente. Instale com: sudo apt install ffmpeg"
  echo "        A API sobe, mas nenhum corte sera renderizado."
fi

# --------------------------------------------------------------------------
#  4. Frontend
# --------------------------------------------------------------------------
SKIP_WEB=0
if command -v npm >/dev/null 2>&1; then
  if [ ! -d "frontend/node_modules" ]; then
    echo "  [..]  Instalando dependencias do frontend, isso leva um minuto..."
    (cd frontend && npm install --no-fund --no-audit) || fail "npm install falhou."
  fi
  echo "  [ok]  Frontend"
else
  echo "  [!!]  Node.js ausente. Apenas a API sera iniciada."
  SKIP_WEB=1
fi

# --------------------------------------------------------------------------
#  5. Sobe os servicos
# --------------------------------------------------------------------------
API_PID=""
WEB_PID=""

cleanup() {
  echo
  echo "  Encerrando..."
  # Mata o grupo de processos de cada servico: o uvicorn com --reload e o vite
  # criam filhos que sobreviveriam a um kill no PID direto.
  for pid in "$API_PID" "$WEB_PID"; do
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null
  done
  wait 2>/dev/null
  echo "  Ate mais."
}
trap cleanup EXIT INT TERM

echo
echo "  Iniciando a API em http://127.0.0.1:$API_PORT ..."
setsid "$VENV_PY" backend/cli.py serve &
API_PID=$!

if [ "$SKIP_WEB" -eq 0 ]; then
  echo "  Iniciando a UI  em http://localhost:$WEB_PORT ..."
  (cd frontend && setsid npm run dev) &
  WEB_PID=$!
fi

# Espera a API responder antes de anunciar que esta tudo no ar.
for _ in $(seq 40); do
  if curl -s -f -o /dev/null "http://127.0.0.1:$API_PORT/api/health" 2>/dev/null; then
    echo "  [ok]  API respondendo."
    break
  fi
  sleep 1
done

if [ "$SKIP_WEB" -eq 0 ]; then
  sleep 3
  # Abre o navegador no ambiente grafico disponivel, se houver.
  for opener in xdg-open open; do
    command -v "$opener" >/dev/null 2>&1 && "$opener" "http://localhost:$WEB_PORT" >/dev/null 2>&1 && break
  done
fi

cat <<EOF

  Tudo no ar.
    UI    http://localhost:$WEB_PORT
    API   http://127.0.0.1:$API_PORT/docs
    Saida $ROOT/output/clips

  Ctrl+C encerra os dois servicos.

EOF

wait
