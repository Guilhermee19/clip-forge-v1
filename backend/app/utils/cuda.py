"""Preparacao do ambiente CUDA para o CTranslate2 (faster-whisper).

No Windows, o CTranslate2 procura `cublas64_12.dll` e `cudnn_ops64_9.dll` no
PATH. Quando as libs vem dos wheels `nvidia-*-cu12` (instalados pelo pip), elas
ficam dentro de `site-packages/nvidia/**/bin`, que nao esta no PATH por padrao.

Importar este modulo antes do faster-whisper resolve isso automaticamente.
"""

from __future__ import annotations

import os
import platform
import sys
from pathlib import Path

from app.utils.logging import get_logger

logger = get_logger(__name__)

_PREPARED = False


def _nvidia_lib_dirs() -> list[Path]:
    """Diretorios de DLL/SO dentro dos wheels `nvidia-*` instalados."""
    dirs: list[Path] = []
    for site_dir in sys.path:
        nvidia_root = Path(site_dir) / "nvidia"
        if not nvidia_root.is_dir():
            continue
        # Ex.: nvidia/cublas/bin (Windows) ou nvidia/cublas/lib (Linux)
        for sub in ("bin", "lib"):
            dirs.extend(p for p in nvidia_root.glob(f"*/{sub}") if p.is_dir())
    return dirs


def prepare_cuda_env() -> None:
    """Adiciona as libs CUDA dos wheels da Nvidia ao PATH do processo.

    Chamada de forma idempotente; nao faz nada se as libs nao existirem (o
    usuario pode ter CUDA instalado no sistema, o que ja funciona).
    """
    global _PREPARED
    if _PREPARED:
        return
    _PREPARED = True

    lib_dirs = _nvidia_lib_dirs()
    if not lib_dirs:
        return

    is_windows = platform.system() == "Windows"
    env_key = "PATH" if is_windows else "LD_LIBRARY_PATH"
    current = os.environ.get(env_key, "")
    additions = [str(d) for d in lib_dirs if str(d) not in current]

    if not additions:
        return

    os.environ[env_key] = os.pathsep.join([*additions, current]) if current else os.pathsep.join(additions)

    if is_windows and hasattr(os, "add_dll_directory"):
        for d in lib_dirs:
            try:
                os.add_dll_directory(str(d))
            except OSError:  # pragma: no cover - caminho invalido
                pass

    logger.debug("CUDA libs adicionadas ao %s: %d diretorios", env_key, len(additions))


def resolve_device(requested: str) -> str:
    """Resolve `auto` para `cuda` ou `cpu` conforme a disponibilidade real."""
    if requested != "auto":
        return requested

    prepare_cuda_env()
    try:
        import ctranslate2

        if ctranslate2.get_cuda_device_count() > 0:
            return "cuda"
    except Exception as exc:  # pragma: no cover - depende do ambiente
        logger.debug("Deteccao de CUDA falhou: %s", exc)
    return "cpu"


def resolve_compute_type(device: str, requested: str) -> str:
    """Evita tipos de computacao invalidos quando caimos para CPU."""
    if device == "cpu" and requested in ("float16", "int8_float16"):
        logger.warning("compute_type=%s nao e suportado em CPU; usando int8.", requested)
        return "int8"
    return requested
