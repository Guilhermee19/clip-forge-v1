"""Etapa 2 da pipeline: transcricao com `faster-whisper`.

O modelo e carregado sob demanda e mantido em cache no processo, porque subir um
`large-v3` custa varios segundos e alguns GB de VRAM. Rodar dois jobs em
paralelo com modelos diferentes e o caminho mais rapido para estourar a memoria
da GPU, entao mantemos no maximo uma instancia viva por combinacao de
(modelo, device, compute_type).

Timestamps por palavra sao obrigatorios aqui: eles alimentam tanto o corte fino
dos clipes quanto a legenda animada palavra-a-palavra.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from threading import Lock

from app.config import settings
from app.models import Segment, Transcript, Word
from app.utils.cuda import prepare_cuda_env, resolve_compute_type, resolve_device
from app.utils.logging import get_logger

logger = get_logger(__name__)

ProgressFn = Callable[[float, str], None]

_model_cache: dict[tuple[str, str, str], object] = {}
_model_lock = Lock()


def _load_model(model_name: str, device: str, compute_type: str):
    """Carrega (ou reaproveita) um `WhisperModel` para a configuracao dada."""
    key = (model_name, device, compute_type)

    with _model_lock:
        if key in _model_cache:
            return _model_cache[key]

        prepare_cuda_env()
        from faster_whisper import WhisperModel

        logger.info(
            "Carregando Whisper '%s' em %s (%s)...", model_name, device, compute_type
        )
        try:
            model = WhisperModel(model_name, device=device, compute_type=compute_type)
        except Exception as exc:
            if device == "cuda":
                logger.warning(
                    "Falha ao carregar em CUDA (%s). Caindo para CPU/int8.", exc
                )
                model = WhisperModel(model_name, device="cpu", compute_type="int8")
                key = (model_name, "cpu", "int8")
            else:
                raise

        _model_cache[key] = model
        return model


def unload_models() -> None:
    """Libera a VRAM ocupada pelos modelos em cache."""
    with _model_lock:
        _model_cache.clear()
    logger.info("Modelos Whisper descarregados.")


def transcribe(
    audio_path: str | Path,
    *,
    language: str | None = None,
    duration_hint: float | None = None,
    on_progress: ProgressFn | None = None,
) -> Transcript:
    """Transcreve um arquivo de audio com timestamps por palavra.

    Args:
        audio_path: WAV/MP3/qualquer coisa que o ffmpeg leia (ideal: WAV 16 kHz).
        language: codigo ISO do idioma; `None` deixa o Whisper detectar.
        duration_hint: duracao total, usada apenas para calcular o progresso.
        on_progress: callback `(fracao, mensagem)`.

    Returns:
        Um `Transcript` com segmentos e palavras alinhadas.
    """
    audio_path = Path(audio_path)
    device = resolve_device(settings.whisper_device)
    compute_type = resolve_compute_type(device, settings.whisper_compute_type)
    model = _load_model(settings.whisper_model, device, compute_type)

    if on_progress:
        on_progress(0.0, f"Transcrevendo com {settings.whisper_model} em {device}...")

    # `transcribe` devolve um gerador preguicoso: o trabalho pesado so acontece
    # enquanto iteramos, o que nos permite reportar progresso real.
    raw_segments, info = model.transcribe(
        str(audio_path),
        language=language or settings.whisper_language or None,
        beam_size=settings.whisper_beam_size,
        word_timestamps=True,
        vad_filter=settings.whisper_vad_filter,
        vad_parameters={"min_silence_duration_ms": 500},
        condition_on_previous_text=False,  # evita loops de repeticao em lives longas
    )

    total = duration_hint or getattr(info, "duration", 0.0) or 0.0
    segments: list[Segment] = []

    for index, raw in enumerate(raw_segments):
        words = [
            Word(
                text=w.word,
                start=float(w.start),
                end=float(w.end),
                probability=float(getattr(w, "probability", 1.0) or 1.0),
            )
            for w in (raw.words or [])
            if w.start is not None and w.end is not None
        ]

        segments.append(
            Segment(
                id=index,
                start=float(raw.start),
                end=float(raw.end),
                text=raw.text.strip(),
                words=words,
            )
        )

        if on_progress and total:
            fraction = min(0.99, float(raw.end) / total)
            on_progress(fraction, f"Transcrevendo... {fraction * 100:.0f}%")

    transcript = Transcript(
        language=getattr(info, "language", language or settings.whisper_language),
        duration=total or (segments[-1].end if segments else 0.0),
        segments=segments,
    )

    if on_progress:
        on_progress(1.0, f"Transcricao concluida: {len(segments)} segmentos.")

    logger.info(
        "Transcricao: %d segmentos, %d palavras, idioma=%s",
        len(segments),
        sum(len(s.words) for s in segments),
        transcript.language,
    )
    return transcript


# ---------------------------------------------------------------------------
# Persistencia
# ---------------------------------------------------------------------------


def save_transcript(transcript: Transcript, destination: str | Path) -> Path:
    """Grava a transcricao como JSON (serve de cache entre execucoes)."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        json.dumps(transcript.to_dict(), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return destination


def load_transcript(path: str | Path) -> Transcript | None:
    """Le uma transcricao salva; devolve `None` se o arquivo nao existir."""
    path = Path(path)
    if not path.exists():
        return None
    try:
        return Transcript.from_dict(json.loads(path.read_text(encoding="utf-8")))
    except (json.JSONDecodeError, KeyError) as exc:
        logger.warning("Transcricao em cache invalida (%s): %s", path.name, exc)
        return None


def to_srt(transcript: Transcript) -> str:
    """Exporta a transcricao completa em SRT (util para revisao manual)."""

    def stamp(seconds: float) -> str:
        ms = int(round(seconds * 1000))
        h, ms = divmod(ms, 3_600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    lines: list[str] = []
    for i, segment in enumerate(transcript.segments, start=1):
        lines.append(str(i))
        lines.append(f"{stamp(segment.start)} --> {stamp(segment.end)}")
        lines.append(segment.text)
        lines.append("")
    return "\n".join(lines)
