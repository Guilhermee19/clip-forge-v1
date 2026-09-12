"""Quais modelos do Ollama servem para escolher os cortes — e trocar entre eles.

O `OLLAMA_MODEL` era uma string solta no `.env`: para testar outro modelo voce
editava o arquivo na mao, reiniciava o backend e torcia para o tag existir.

Este modulo tem a lista curada do que funciona bem *nesta* tarefa, o estado de
cada um (baixado? em uso?) e a troca em si, que grava no `.env` e ja atualiza a
configuracao em memoria.

O que a tarefa exige, e que guiou a curadoria:

- **JSON confiavel**: o analyzer chama o Ollama com `format: "json"` e um schema
  rigido. Modelo que enfeita a resposta quebra a pipeline.
- **Portugues**: titulo, resumo e justificativa saem em pt-BR.
- **Contexto grande**: transcricao de live e enorme; quanto mais cabe por
  chamada, menos a selecao perde o fio entre os blocos.
- **Caber na GPU**: o Whisper ja ocupa VRAM. Modelo que nao cabe cai para a CPU
  e leva minutos por bloco.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import httpx

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# `familia:tag` — o que o `ollama pull` aceita. Como o nome escolhido vira
# argumento de subprocess, ele passa por aqui antes.
TAG_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,96}(:[a-zA-Z0-9._-]{1,64})?$")


@dataclass(frozen=True)
class ModelOption:
    """Um modelo recomendado, com o que importa para decidir."""

    name: str
    label: str
    params: str
    # Tamanho do download, em GB.
    download_gb: float
    # VRAM confortavel para rodar sem cair para a CPU, em GB.
    vram_gb: float
    # Janela de contexto do modelo, como o Ollama publica.
    context: str
    tier: str  # leve | equilibrado | forte
    note: str
    # `num_ctx` que vale a pena usar com ele (limitado pela VRAM, nao pelo
    # maximo teorico do modelo).
    suggested_num_ctx: int
    # Modelos de raciocinio pensam antes de responder: mais lentos, e a
    # resposta vem embrulhada num bloco <think>.
    thinking: bool = False


# Tags conferidos na biblioteca do Ollama. Os curtos (`qwen3:8b`) resolvem para
# a quantizacao q4_K_M, que e o equilibrio certo para GPU de consumidor.
CATALOG: list[ModelOption] = [
    ModelOption(
        name="qwen3:8b",
        label="Qwen3 8B",
        params="8B",
        download_gb=5.2,
        vram_gb=6.0,
        context="40K",
        tier="equilibrado",
        note=(
            "O melhor custo-beneficio para esta tarefa: segue schema JSON sem escorregar "
            "e escreve titulo em portugues que da para publicar sem reescrever."
        ),
        suggested_num_ctx=16384,
        thinking=True,
    ),
    ModelOption(
        name="gemma3:12b",
        label="Gemma 3 12B",
        params="12B",
        download_gb=8.1,
        vram_gb=9.0,
        context="128K",
        tier="forte",
        note=(
            "O mais forte em portugues da lista — pega ironia e girias que os outros "
            "leem ao pe da letra. Peca 10 GB de VRAM livres."
        ),
        suggested_num_ctx=24576,
    ),
    ModelOption(
        name="qwen3:14b",
        label="Qwen3 14B",
        params="14B",
        download_gb=9.3,
        vram_gb=10.0,
        context="40K",
        tier="forte",
        note=(
            "Escolhe o comeco e o fim do corte com mais precisao: erra menos o momento "
            "do gancho. Em troca, cada bloco leva umas 3x mais tempo que o 8B."
        ),
        suggested_num_ctx=16384,
        thinking=True,
    ),
    ModelOption(
        name="llama3.1:8b-instruct-q4_K_M",
        label="Llama 3.1 8B",
        params="8B",
        download_gb=4.9,
        vram_gb=6.0,
        context="128K",
        tier="equilibrado",
        note=(
            "O padrao historico do ClipForge. Solido e previsivel; hoje o Qwen3 8B "
            "seleciona um pouco melhor pelo mesmo preco de VRAM."
        ),
        suggested_num_ctx=16384,
    ),
    ModelOption(
        name="qwen2.5:7b",
        label="Qwen2.5 7B",
        params="7B",
        download_gb=4.7,
        vram_gb=6.0,
        context="32K",
        tier="equilibrado",
        note=(
            "Nao raciocina antes de responder, entao e o mais rapido dos medios. "
            "Boa escolha se voce processa muita live e quer o resultado logo."
        ),
        suggested_num_ctx=12288,
    ),
    ModelOption(
        name="gemma3:4b",
        label="Gemma 3 4B",
        params="4B",
        download_gb=3.3,
        vram_gb=4.0,
        context="128K",
        tier="leve",
        note=(
            "Cabe junto do Whisper numa GPU de 6-8 GB sem brigar por VRAM, e ainda "
            "mantem o portugues decente."
        ),
        suggested_num_ctx=12288,
    ),
    ModelOption(
        name="qwen3:4b",
        label="Qwen3 4B",
        params="4B",
        download_gb=2.5,
        vram_gb=4.0,
        context="256K",
        tier="leve",
        note=(
            "O menor que ainda acerta o JSON, e o de maior contexto da lista: da para "
            "mandar blocos enormes de transcricao de uma vez."
        ),
        suggested_num_ctx=32768,
        thinking=True,
    ),
]


def _by_name(name: str) -> ModelOption | None:
    return next((m for m in CATALOG if m.name == name), None)


# ---------------------------------------------------------------------------
# Estado
# ---------------------------------------------------------------------------


def installed() -> dict[str, float]:
    """Modelos ja baixados, mapeados para o tamanho em GB.

    Devolve `{}` quando o Ollama nao responde — a interface mostra o catalogo
    mesmo assim, so sem marcar nada como instalado.
    """
    host = settings.ollama_host.rstrip("/")
    try:
        response = httpx.get(f"{host}/api/tags", timeout=5.0)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        logger.debug("Lista de modelos indisponivel: %s", exc)
        return {}

    return {
        model["name"]: round(model.get("size", 0) / 1_000_000_000, 1)
        for model in response.json().get("models", [])
        if model.get("name")
    }


def options() -> dict[str, Any]:
    """Catalogo + o que esta baixado + o que esta em uso, para a interface.

    Modelos que voce baixou por fora entram como "extras": nao sao recomendados
    aqui, mas continuam selecionaveis.
    """
    have = installed()
    active = settings.ollama_model

    curated = [
        {
            **asdict(option),
            "installed": option.name in have,
            "active": option.name == active,
        }
        for option in CATALOG
    ]

    extras = [
        {"name": name, "size_gb": size, "active": name == active}
        for name, size in sorted(have.items())
        if _by_name(name) is None
    ]

    return {
        "active": active,
        "num_ctx": settings.ollama_num_ctx,
        "available": bool(have),
        "models": curated,
        "extras": extras,
    }


# ---------------------------------------------------------------------------
# Troca
# ---------------------------------------------------------------------------


def select(name: str, *, num_ctx: int | None = None) -> dict[str, Any]:
    """Passa a usar `name`, gravando no `.env` e na configuracao em memoria.

    Raises:
        ValueError: tag fora do formato aceito pelo Ollama.
    """
    name = name.strip()
    if not TAG_RE.match(name):
        raise ValueError(f"'{name}' nao parece um modelo do Ollama (ex.: qwen3:8b).")

    option = _by_name(name)
    effective_ctx = num_ctx or (option.suggested_num_ctx if option else settings.ollama_num_ctx)

    _write_env({"OLLAMA_MODEL": name, "OLLAMA_NUM_CTX": str(effective_ctx)})

    # A configuracao e um singleton cacheado: sem isto, a troca so valeria no
    # proximo boot do backend.
    settings.ollama_model = name
    settings.ollama_num_ctx = effective_ctx

    logger.info("Modelo do Ollama agora e %s (num_ctx=%d)", name, effective_ctx)
    return {"active": name, "num_ctx": effective_ctx}


def _write_env(values: dict[str, str]) -> None:
    """Atualiza chaves no `.env` da raiz, preservando o resto do arquivo."""
    path: Path = settings.project_root / ".env"
    lines = path.read_text(encoding="utf-8").splitlines() if path.is_file() else []

    for key, value in values.items():
        replacement = f"{key}={value}"
        for index, line in enumerate(lines):
            if line.strip().startswith(f"{key}="):
                lines[index] = replacement
                break
        else:
            lines.append(replacement)

    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
