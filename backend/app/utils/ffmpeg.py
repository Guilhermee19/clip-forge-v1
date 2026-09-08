"""Camada fina sobre os binarios `ffmpeg` / `ffprobe`.

Usamos subprocess diretamente (em vez do `ffmpeg-python`) nos caminhos criticos
porque precisamos de controle total sobre a ordem dos argumentos do NVENC e do
`filter_complex`, alem de ler o progresso em tempo real.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable, Iterable
from pathlib import Path

from app.config import settings
from app.models import MediaInfo
from app.utils.logging import get_logger

logger = get_logger(__name__)

_TIME_RE = re.compile(r"out_time_ms=(\d+)")


class FFmpegError(RuntimeError):
    """Erro de execucao do ffmpeg, com o final do stderr anexado."""


# ---------------------------------------------------------------------------
# Deteccao de capacidades
# ---------------------------------------------------------------------------


def ffmpeg_available() -> bool:
    return shutil.which(settings.ffmpeg_bin) is not None


def list_encoders() -> set[str]:
    """Nomes de todos os encoders compilados no ffmpeg local."""
    try:
        proc = subprocess.run(
            [settings.ffmpeg_bin, "-hide_banner", "-encoders"],
            capture_output=True,
            text=True,
            check=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return set()

    encoders: set[str] = set()
    for line in proc.stdout.splitlines():
        parts = line.split()
        # Formato: " V....D h264_nvenc  NVIDIA NVENC H.264 encoder"
        if len(parts) >= 2 and len(parts[0]) == 6 and parts[0][0] in "VAS":
            encoders.add(parts[1])
    return encoders


def has_nvenc() -> bool:
    """True se o ffmpeg local tem suporte a `h264_nvenc`."""
    return "h264_nvenc" in list_encoders()


def pick_encoder() -> str:
    """Encoder configurado, com fallback automatico para `libx264` sem NVENC."""
    wanted = settings.video_encoder
    if "nvenc" not in wanted:
        return wanted
    if wanted in list_encoders():
        return wanted
    logger.warning("%s indisponivel neste ffmpeg; caindo para libx264 (CPU).", wanted)
    return "libx264"


def encoder_quality_args(encoder: str) -> list[str]:
    """Argumentos de qualidade/velocidade especificos de cada encoder."""
    if "nvenc" in encoder:
        return [
            "-preset", settings.nvenc_preset,
            "-tune", "hq",
            "-rc", "vbr",
            "-cq", str(settings.nvenc_cq),
            "-b:v", "0",              # 0 = bitrate guiado apenas pelo CQ
            "-rc-lookahead", "20",
            "-spatial-aq", "1",
            "-aq-strength", "8",
        ]
    return ["-preset", "medium", "-crf", str(settings.nvenc_cq)]


# ---------------------------------------------------------------------------
# Sondagem de midia
# ---------------------------------------------------------------------------


def probe(path: str | Path) -> MediaInfo:
    """Le metadados do arquivo com ffprobe."""
    path = Path(path)
    cmd = [
        settings.ffprobe_bin,
        "-v", "error",
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        str(path),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"ffprobe falhou em {path}: {proc.stderr.strip()[-500:]}")

    data = json.loads(proc.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    if video is None:
        raise FFmpegError(f"Nenhuma trilha de video encontrada em {path}")

    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0.0)
    fps = _parse_fraction(video.get("avg_frame_rate") or video.get("r_frame_rate") or "0/1")
    title = data.get("format", {}).get("tags", {}).get("title") or path.stem

    return MediaInfo(
        path=str(path),
        title=title,
        duration=duration,
        width=int(video.get("width", 0)),
        height=int(video.get("height", 0)),
        fps=fps or 30.0,
        has_audio=audio is not None,
    )


def _parse_fraction(value: str) -> float:
    """Converte `30000/1001` (formato do ffprobe) em float."""
    try:
        num, _, den = value.partition("/")
        den_f = float(den) if den else 1.0
        return float(num) / den_f if den_f else 0.0
    except (ValueError, ZeroDivisionError):
        return 0.0


# ---------------------------------------------------------------------------
# Execucao
# ---------------------------------------------------------------------------


def run(
    args: Iterable[str],
    *,
    total_duration: float | None = None,
    on_progress: Callable[[float], None] | None = None,
    description: str = "ffmpeg",
    cwd: str | Path | None = None,
) -> None:
    """Executa o ffmpeg, opcionalmente reportando progresso de 0.0 a 1.0.

    Args:
        args: argumentos *sem* o binario (ele e prefixado automaticamente).
        total_duration: duracao esperada da saida, para calcular o percentual.
        on_progress: callback chamado com a fracao ja concluida.
        description: rotulo usado nas mensagens de log e de erro.
        cwd: diretorio de trabalho do processo. Usado para referenciar arquivos
            de legenda pelo nome, o que evita o inferno de escape de caminhos
            do Windows dentro do filtergraph.
    """
    cmd = [settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    if on_progress and total_duration:
        cmd += ["-progress", "pipe:1", "-stats_period", "0.5"]
    cmd += [str(a) for a in args]

    logger.debug("%s: %s", description, " ".join(cmd))

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(cwd) if cwd else None,
    )

    if on_progress and total_duration and proc.stdout:
        for line in proc.stdout:
            match = _TIME_RE.search(line)
            if match:
                seconds = int(match.group(1)) / 1_000_000
                on_progress(min(1.0, seconds / max(total_duration, 0.001)))

    _, stderr = proc.communicate()
    if proc.returncode != 0:
        tail = (stderr or "")[-1500:]
        raise FFmpegError(f"{description} falhou (codigo {proc.returncode}):\n{tail}")

    if on_progress:
        on_progress(1.0)


# ---------------------------------------------------------------------------
# Operacoes de alto nivel
# ---------------------------------------------------------------------------


def extract_audio(
    source: str | Path,
    destination: str | Path,
    *,
    sample_rate: int = 16_000,
    channels: int = 1,
) -> Path:
    """Extrai a trilha de audio em WAV mono 16 kHz (formato ideal do Whisper)."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "-i", str(source),
            "-vn",
            "-ac", str(channels),
            "-ar", str(sample_rate),
            "-c:a", "pcm_s16le",
            str(destination),
        ],
        description="extracao de audio",
    )
    return destination


def decode_pcm(source: str | Path, sample_rate: int = 16_000) -> bytes:
    """Decodifica o audio para PCM 16-bit mono cru, direto em memoria."""
    cmd = [
        settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin",
        "-i", str(source),
        "-vn",
        "-ac", "1",
        "-ar", str(sample_rate),
        "-f", "s16le",
        "-",
    ]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        detail = proc.stderr.decode(errors="ignore")[-500:]
        raise FFmpegError(f"Decodificacao PCM falhou: {detail}")
    return proc.stdout


def grab_thumbnail(
    source: str | Path,
    destination: str | Path,
    *,
    timestamp: float = 0.0,
    width: int = 540,
) -> Path:
    """Salva um frame como JPEG para servir de capa do corte."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "-ss", f"{timestamp:.3f}",
            "-i", str(source),
            "-frames:v", "1",
            "-vf", f"scale={width}:-2",
            "-q:v", "3",
            str(destination),
        ],
        description="thumbnail",
    )
    return destination


def escape_filter_path(path: str | Path) -> str:
    """Escapa um caminho para uso dentro de um filtro do ffmpeg.

    O filtro `subtitles=` passa por dois niveis de parsing, entao caminhos do
    Windows (`C:\\Users\\...`) precisam virar `C\\:/Users/...` para nao serem
    lidos como separador de opcao do filtro.
    """
    text = str(path).replace("\\", "/")
    text = text.replace(":", r"\:")
    text = text.replace("'", r"\'")
    return text
