"""Etapa 1 da pipeline: ingestao da midia.

Aceita duas origens:
  * uma URL (YouTube, Twitch VOD, etc.) baixada com `yt-dlp`;
  * um arquivo local ja existente no disco.

Em ambos os casos a saida e um `MediaInfo` apontando para um arquivo local, mais
o WAV mono 16 kHz que as etapas de transcricao e analise de audio consomem.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from collections.abc import Callable
from pathlib import Path

from app.config import settings
from app.models import MediaInfo
from app.utils import ffmpeg
from app.utils.logging import get_logger

logger = get_logger(__name__)

ProgressFn = Callable[[float, str], None]

_URL_RE = re.compile(r"^https?://", re.IGNORECASE)

# Containers que o yt-dlp pode produzir. Tudo o que nao estiver aqui e sobra do
# processo de download: `.part` (arquivo em andamento), `.ytdl` (estado da
# retomada), `.part-FragNNN.part` (fragmentos de um download segmentado).
_VIDEO_SUFFIXES = frozenset(
    {".mp4", ".mkv", ".webm", ".mov", ".m4v", ".avi", ".ts", ".flv"}
)


def is_url(source: str) -> bool:
    """True se a string parece uma URL http(s)."""
    return bool(_URL_RE.match(source.strip()))


def _slugify(text: str, max_length: int = 60) -> str:
    """Nome de arquivo seguro em qualquer SO, derivado do titulo do video."""
    slug = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    slug = re.sub(r"[\s_-]+", "-", slug)
    return slug[:max_length].strip("-") or "video"


def _cache_key(source: str) -> str:
    """Chave curta e estavel para reaproveitar downloads ja feitos."""
    return hashlib.sha1(source.encode("utf-8")).hexdigest()[:12]


def _download_hint(message: str, yt_dlp_module) -> str:
    """Traduz uma falha do yt-dlp na acao que costuma resolver.

    "Requested format is not available" quase nunca e o seletor de formato: e o
    yt-dlp desatualizado. Quando o YouTube muda a extracao de assinatura, uma
    versao antiga descarta todos os formatos de video e so lista storyboards,
    e o erro que chega ao usuario nao diz nada sobre isso.
    """
    version = getattr(yt_dlp_module.version, "__version__", "desconhecida")
    lowered = message.lower()

    if "requested format is not available" in lowered or "only images are available" in lowered:
        return (
            f"O yt-dlp ({version}) nao encontrou formatos de video para esta URL.\n"
            f"Na maioria das vezes isso e versao desatualizada, nao o seletor de formato.\n"
            f"Atualize com:  pip install --upgrade yt-dlp\n"
            f"Se persistir, veja os formatos reais com:  "
            f"python -m yt_dlp --list-formats \"<url>\"\n"
            f"Detalhe original: {message.strip()[:300]}"
        )

    if "sign in" in lowered or "age" in lowered and "restrict" in lowered:
        return (
            f"O video exige login (idade ou acesso restrito).\n"
            f"Exporte os cookies do navegador e aponte YTDLP_COOKIES no .env.\n"
            f"Detalhe original: {message.strip()[:300]}"
        )

    if "private" in lowered or "unavailable" in lowered:
        return f"Video indisponivel ou privado. Detalhe: {message.strip()[:300]}"

    return f"Download falhou (yt-dlp {version}): {message.strip()[:400]}"


def _find_video(cache_dir: Path) -> Path | None:
    """Video completo dentro do diretorio de cache, se houver um.

    Filtra pela extensao real do container: um glob ingenuo por `source.*` pega
    tambem `source.mp4.ytdl` e os fragmentos, e o ffprobe morre com "Invalid
    data found when processing input" ao tentar ler esses arquivos.
    """
    candidates = [
        path
        for path in cache_dir.glob("source.*")
        if path.is_file()
        and path.suffix.lower() in _VIDEO_SUFFIXES
        and path.stat().st_size > 0
    ]
    if not candidates:
        return None

    # `source.mp4` (merge final) vem antes de `source.f137.mp4` (faixa isolada
    # que sobrou de um merge interrompido); em empate, o maior arquivo.
    candidates.sort(key=lambda p: (p.name.count("."), -p.stat().st_size))
    return candidates[0]


_COVER_SUFFIXES = (".jpg", ".jpeg", ".png", ".webp")


def find_cover(video_path: str | Path) -> Path | None:
    """Capa que o yt-dlp baixou ao lado do video, se houver."""
    directory = Path(video_path).parent
    covers = [
        path
        for path in directory.glob("source.*")
        if path.is_file() and path.suffix.lower() in _COVER_SUFFIXES and path.stat().st_size > 0
    ]
    return max(covers, key=lambda p: p.stat().st_size) if covers else None


def _download_in_progress(cache_dir: Path) -> bool:
    """True se ha residuo de um download incompleto no diretorio."""
    return any(cache_dir.glob("source.*.part")) or any(cache_dir.glob("source.*.ytdl"))


# ---------------------------------------------------------------------------
# Download
# ---------------------------------------------------------------------------


def download(url: str, *, on_progress: ProgressFn | None = None) -> Path:
    """Baixa o video com yt-dlp para o diretorio de cache.

    Downloads sao cacheados pela hash da URL: rodar o mesmo link duas vezes nao
    baixa de novo. Retorna o caminho do arquivo baixado.
    """
    import yt_dlp

    key = _cache_key(url)
    cache_dir = settings.cache_dir / key
    cache_dir.mkdir(parents=True, exist_ok=True)

    # Reaproveita um download anterior, mas so se ele tiver terminado: com
    # residuo de `.part`/`.ytdl` no diretorio, o que existe ainda esta pela
    # metade e o yt-dlp deve retomar de onde parou.
    existing = _find_video(cache_dir)
    if existing and not _download_in_progress(cache_dir):
        logger.info("Video ja em cache: %s", existing.name)
        if on_progress:
            on_progress(1.0, "Video ja estava em cache")
        return existing

    if existing:
        logger.info("Download anterior incompleto em %s; retomando.", cache_dir.name)

    def hook(status: dict) -> None:
        if not on_progress:
            return
        if status["status"] == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            done = status.get("downloaded_bytes", 0)
            fraction = done / total if total else 0.0
            speed = status.get("speed") or 0
            on_progress(fraction, f"Baixando... {fraction * 100:.0f}% ({speed / 1e6:.1f} MB/s)")
        elif status["status"] == "finished":
            on_progress(1.0, "Download concluido, remuxando...")

    options: dict = {
        "format": settings.ytdlp_format,
        "outtmpl": str(cache_dir / "source.%(ext)s"),
        "merge_output_format": "mp4",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "progress_hooks": [hook],
        "retries": 5,
        "concurrent_fragment_downloads": 4,
        # A capa oficial do video vale mais que um frame qualquer na listagem
        # de projetos: e a miniatura que a pessoa reconhece.
        "writethumbnail": True,
    }
    if settings.ytdlp_cookies:
        options["cookiefile"] = settings.ytdlp_cookies

    logger.info("Baixando %s (yt-dlp %s)", url, getattr(yt_dlp.version, "__version__", "?"))
    try:
        with yt_dlp.YoutubeDL(options) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as exc:
        raise RuntimeError(_download_hint(str(exc), yt_dlp)) from exc

    downloaded = _find_video(cache_dir)
    if downloaded is None:
        raise RuntimeError(
            f"yt-dlp nao produziu um arquivo de video para {url}. "
            f"Verifique o diretorio {cache_dir}."
        )

    # Guarda o titulo original ao lado do video para a UI exibir depois. A URL
    # vai junto porque a chave do cache e um hash: sem ela, um item orfao (sem
    # projeto) nao teria como ser reprocessado.
    title = (info or {}).get("title", "")
    if title:
        (cache_dir / "title.txt").write_text(title, encoding="utf-8")
    (cache_dir / "source.url.txt").write_text(url, encoding="utf-8")

    return downloaded


# ---------------------------------------------------------------------------
# Entrada unificada
# ---------------------------------------------------------------------------


def ingest(source: str, *, on_progress: ProgressFn | None = None) -> MediaInfo:
    """Resolve `source` (URL ou caminho local) para um `MediaInfo` local.

    Args:
        source: URL de video ou caminho de arquivo no disco.
        on_progress: callback `(fracao, mensagem)` para status em tempo real.

    Raises:
        FileNotFoundError: se o caminho local nao existir.
    """
    if is_url(source):
        path = download(source, on_progress=on_progress)
        title_file = path.parent / "title.txt"
        friendly_title = title_file.read_text(encoding="utf-8").strip() if title_file.exists() else path.stem
        info = ffmpeg.probe(path)
        info.title = friendly_title
        info.source_url = source
        return info

    path = Path(source).expanduser()
    if not path.exists():
        raise FileNotFoundError(f"Arquivo de entrada nao encontrado: {path}")

    if on_progress:
        on_progress(1.0, f"Usando arquivo local: {path.name}")

    info = ffmpeg.probe(path)
    info.title = path.stem
    return info


def prepare_audio(media: MediaInfo) -> Path:
    """Garante um WAV mono 16 kHz para a midia, com cache em disco."""
    key = _cache_key(media.source_url or media.path)
    audio_path = settings.cache_dir / key / "audio.wav"

    if audio_path.exists() and audio_path.stat().st_size > 0:
        logger.debug("Audio ja extraido: %s", audio_path)
        return audio_path

    logger.info("Extraindo audio de %s", Path(media.path).name)
    return ffmpeg.extract_audio(media.path, audio_path)


def stage_upload(temp_path: str | Path, original_name: str) -> Path:
    """Move um arquivo enviado pela UI para `output/uploads/` com nome legivel."""
    temp_path = Path(temp_path)
    suffix = Path(original_name).suffix or temp_path.suffix or ".mp4"
    destination = settings.uploads_dir / f"{_slugify(Path(original_name).stem)}{suffix}"

    counter = 1
    while destination.exists():
        destination = destination.with_name(f"{destination.stem}-{counter}{suffix}")
        counter += 1

    shutil.move(str(temp_path), destination)
    return destination
