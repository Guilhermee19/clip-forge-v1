"""Logging unificado com saida colorida via `rich`."""

from __future__ import annotations

import logging

from rich.logging import RichHandler

_CONFIGURED = False


def setup_logging(level: str = "INFO") -> None:
    """Configura o root logger uma unica vez por processo."""
    global _CONFIGURED
    if _CONFIGURED:
        return

    logging.basicConfig(
        level=level.upper(),
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(rich_tracebacks=True, show_path=False, markup=False)],
    )
    # Bibliotecas barulhentas.
    for noisy in ("httpx", "urllib3", "faster_whisper", "matplotlib"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Atalho para obter um logger ja configurado."""
    setup_logging()
    return logging.getLogger(name)
