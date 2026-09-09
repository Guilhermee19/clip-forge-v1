"""Logging unificado com saida colorida via `rich`."""

from __future__ import annotations

import logging
import sys

from rich.console import Console
from rich.logging import RichHandler

_CONFIGURED = False


def force_utf8_streams() -> None:
    """Garante que stdout/stderr aguentem os caracteres que o `rich` emite.

    O console do Windows em portugues usa cp1252 por padrao. O spinner do rich
    e desenhado com braille (U+2800+), que nao existe nessa tabela, e a CLI
    morre com `UnicodeEncodeError` no meio de um job — depois de meia hora de
    transcricao. `errors="replace"` garante que, no pior caso, apareca um `?`
    em vez de derrubar o processo.
    """
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            try:
                stream.reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):  # stream ja fechado ou sem suporte
                pass


def setup_logging(level: str = "INFO") -> None:
    """Configura o root logger uma unica vez por processo."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    force_utf8_streams()

    logging.basicConfig(
        level=level.upper(),
        format="%(message)s",
        datefmt="[%X]",
        handlers=[
            RichHandler(
                console=Console(stderr=True, legacy_windows=False),
                rich_tracebacks=True,
                show_path=False,
                markup=False,
            )
        ],
    )
    # Bibliotecas barulhentas.
    for noisy in ("httpx", "urllib3", "faster_whisper", "matplotlib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Atalho para obter um logger ja configurado."""
    setup_logging()
    return logging.getLogger(name)
