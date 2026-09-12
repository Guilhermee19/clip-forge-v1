"""O que o ClipForge guarda em disco, e como liberar espaco com seguranca.

O cache e o que faz reprocessar um video custar segundos em vez de horas: o
download fica em `output/cache/<chave>/` e a transcricao em
`output/transcripts/<chave>.json`. So que ele cresce sem limite — uma live de
tres horas passa de 10 GB —, e nada na interface mostrava isso.

Duas regras guiam a limpeza aqui:

- **Transcricao e mais cara que o video.** Baixar de novo leva minutos; passar o
  Whisper de novo leva horas. Por isso apagar o video e apagar a transcricao sao
  escolhas separadas, e a transcricao so sai se for pedida explicitamente.
- **Cache em uso nao e lixo.** Um projeto cujo video de origem sumiu perde a
  previa e a re-renderizacao de cortes. A limpeza em lote pula esses por padrao.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from app.config import settings
from app.core import projects
from app.utils.logging import get_logger

logger = get_logger(__name__)

_VIDEO_SUFFIXES = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"}

# A chave do cache e um hash curto. Restringir ao alfabeto dele fecha a porta
# para `..`, barras e qualquer outra coisa que vire caminho.
_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


@dataclass
class CacheEntry:
    """Uma fonte ja processada, com tudo que ela ocupa no disco."""

    key: str
    title: str
    source_url: str | None
    video_bytes: int
    audio_bytes: int
    transcript_bytes: int
    total_bytes: int
    has_video: bool
    has_transcript: bool
    modified_at: float
    # Projeto que ainda depende deste cache para previa e re-render.
    used_by: str | None
    used_by_title: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _dir_size(path: Path) -> int:
    return sum(f.stat().st_size for f in path.rglob("*") if f.is_file())


def _transcript_path(key: str) -> Path:
    return settings.transcripts_dir / f"{key}.json"


def _in_use() -> dict[str, tuple[str, str]]:
    """Mapa `chave do cache -> (id, titulo)` do projeto que a usa.

    A relacao e descoberta pelo caminho do video de origem, nao pela chave: o
    id do projeto e a chave do cache saem do mesmo hash, mas depender disso
    quebraria em silencio se um dos dois mudasse.
    """
    cache_root = settings.cache_dir.resolve()
    mapping: dict[str, tuple[str, str]] = {}

    for project in projects.list_all():
        raw = (project.media or {}).get("path")
        if not raw:
            continue
        try:
            path = Path(raw).resolve()
            relative = path.relative_to(cache_root)
        except (ValueError, OSError):
            continue
        if relative.parts:
            mapping[relative.parts[0]] = (project.id, project.title)

    return mapping


def inventory() -> dict[str, Any]:
    """Tudo que esta em cache, do mais pesado para o mais leve."""
    root = settings.cache_dir
    root.mkdir(parents=True, exist_ok=True)
    used = _in_use()

    entries: list[CacheEntry] = []
    for directory in root.iterdir():
        if not directory.is_dir():
            continue

        key = directory.name
        videos = [f for f in directory.glob("source.*") if f.suffix.lower() in _VIDEO_SUFFIXES]
        audio = directory / "audio.wav"
        transcript = _transcript_path(key)

        title_file = directory / "title.txt"
        url_file = directory / "source.url.txt"
        owner = used.get(key)

        video_bytes = sum(f.stat().st_size for f in videos)
        audio_bytes = audio.stat().st_size if audio.is_file() else 0
        transcript_bytes = transcript.stat().st_size if transcript.is_file() else 0

        entries.append(
            CacheEntry(
                key=key,
                title=(
                    title_file.read_text(encoding="utf-8").strip()
                    if title_file.is_file()
                    else (owner[1] if owner else key)
                ),
                source_url=(
                    url_file.read_text(encoding="utf-8").strip() if url_file.is_file() else None
                ),
                video_bytes=video_bytes,
                audio_bytes=audio_bytes,
                transcript_bytes=transcript_bytes,
                total_bytes=_dir_size(directory) + transcript_bytes,
                has_video=bool(videos),
                has_transcript=transcript.is_file(),
                modified_at=directory.stat().st_mtime,
                used_by=owner[0] if owner else None,
                used_by_title=owner[1] if owner else None,
            )
        )

    entries.sort(key=lambda e: e.total_bytes, reverse=True)

    uploads = settings.uploads_dir
    uploads_bytes = _dir_size(uploads) if uploads.is_dir() else 0
    clips_bytes = _dir_size(settings.output_dir / "projects")

    return {
        "entries": [e.to_dict() for e in entries],
        "cache_bytes": sum(e.total_bytes for e in entries),
        "reusable_bytes": sum(e.total_bytes for e in entries if e.used_by is None),
        "uploads_bytes": uploads_bytes,
        "projects_bytes": clips_bytes,
        "cache_dir": str(settings.cache_dir),
    }


def delete_entry(key: str, *, drop_transcript: bool = False) -> dict[str, Any]:
    """Apaga um item do cache. A transcricao so sai se for pedida.

    Raises:
        KeyError: a chave nao existe no cache.
    """
    # Duas barreiras, porque uma so ja falhou aqui: `Path("..").name` devolve
    # `".."`, entao o teste de "nome simples" deixava passar o pai do cache e o
    # `rmtree` levava o diretorio inteiro junto.
    if not _KEY_RE.match(key):
        raise KeyError(key)

    root = settings.cache_dir.resolve()
    directory = (root / key).resolve()
    if directory.parent != root or not directory.is_dir():
        raise KeyError(key)

    freed = _dir_size(directory)
    shutil.rmtree(directory, ignore_errors=True)

    transcript = _transcript_path(key)
    transcript_freed = 0
    if drop_transcript and transcript.is_file():
        transcript_freed = transcript.stat().st_size
        transcript.unlink(missing_ok=True)

    logger.info(
        "Cache %s removido (%.1f MB%s)",
        key,
        freed / 1e6,
        f" + transcricao {transcript_freed / 1e6:.1f} MB" if transcript_freed else "",
    )
    return {"key": key, "freed_bytes": freed + transcript_freed}


def cleanup(*, keep_in_use: bool = True, drop_transcripts: bool = False) -> dict[str, Any]:
    """Limpa o cache em lote.

    Args:
        keep_in_use: preserva o cache de projetos que ainda existem — sem ele,
            esses projetos perdem a previa e a re-renderizacao.
        drop_transcripts: apaga tambem as transcricoes, que sao o item mais
            caro de refazer.

    Returns:
        Quantos itens sairam e quantos bytes foram liberados.
    """
    used = _in_use()
    removed: list[str] = []
    freed = 0

    for directory in list(settings.cache_dir.iterdir()):
        if not directory.is_dir():
            continue
        if keep_in_use and directory.name in used:
            continue

        result = delete_entry(directory.name, drop_transcript=drop_transcripts)
        removed.append(directory.name)
        freed += result["freed_bytes"]

    logger.info("Limpeza de cache: %d item(ns), %.1f MB liberados", len(removed), freed / 1e6)
    return {"removed": removed, "freed_bytes": freed}
