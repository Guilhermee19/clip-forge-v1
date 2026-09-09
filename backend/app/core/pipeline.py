"""Orquestracao: liga as cinco etapas da pipeline e reporta progresso.

Cada etapa tem um peso no progresso total, calibrado pelo tempo real que costuma
levar num RTX de mesa: a transcricao domina, o render vem em seguida.

O `on_event` recebe um dicionario a cada mudanca de estado — e o mesmo payload
que a API empurra pelo WebSocket e que a CLI imprime no terminal.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.config import settings
from app.core import analyzer, audio_energy, ingest, reframer, renderer, transcriber
from app.models import ClipCandidate, MediaInfo, RenderedClip, Transcript
from app.utils.logging import get_logger

logger = get_logger(__name__)

EventFn = Callable[[dict[str, Any]], None]

# Peso de cada etapa no progresso global (soma 1.0).
STAGE_WEIGHTS: dict[str, float] = {
    "ingest": 0.10,
    "transcribe": 0.35,
    "audio": 0.05,
    "analyze": 0.15,
    "render": 0.35,
}

STAGE_LABELS: dict[str, str] = {
    # Cobre tanto o download de uma URL quanto o uso de um arquivo local.
    "ingest": "Preparando midia",
    "transcribe": "Transcrevendo audio",
    "audio": "Analisando energia do audio",
    "analyze": "Selecionando os melhores trechos",
    "render": "Reenquadrando e renderizando",
    "done": "Concluido",
    "error": "Falhou",
}


@dataclass(slots=True)
class PipelineOptions:
    """Parametros de uma execucao, sobrescrevendo o `.env` quando informados."""

    min_clips: int | None = None
    max_clips: int | None = None
    language: str | None = None
    reframe_mode: str | None = None
    burn_subtitles: bool | None = None
    # Reaproveita a transcricao salva em disco, se houver.
    use_cache: bool = True
    # Analisa e escolhe os cortes, mas nao renderiza (util para revisar antes).
    dry_run: bool = False


@dataclass(slots=True)
class PipelineResult:
    """Tudo que uma execucao produziu."""

    media: MediaInfo
    transcript: Transcript
    candidates: list[ClipCandidate]
    clips: list[RenderedClip] = field(default_factory=list)
    elapsed: float = 0.0
    transcript_path: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "media": self.media.to_dict(),
            "transcript_path": self.transcript_path,
            "candidates": [c.to_dict() for c in self.candidates],
            "clips": [c.to_dict() for c in self.clips],
            "elapsed": round(self.elapsed, 1),
            "transcript_language": self.transcript.language,
        }


class ProgressReporter:
    """Traduz o progresso local de cada etapa em progresso global 0-1."""

    def __init__(self, on_event: EventFn | None = None) -> None:
        self._on_event = on_event
        self._completed = 0.0
        self._stage = "ingest"

    def start_stage(self, stage: str) -> None:
        self._stage = stage
        self.emit(0.0, STAGE_LABELS.get(stage, stage))

    def finish_stage(self, stage: str) -> None:
        self._completed += STAGE_WEIGHTS.get(stage, 0.0)

    def emit(self, stage_fraction: float, message: str, **extra: Any) -> None:
        """Publica um evento de progresso."""
        weight = STAGE_WEIGHTS.get(self._stage, 0.0)
        overall = min(1.0, self._completed + weight * max(0.0, min(stage_fraction, 1.0)))

        if self._on_event:
            self._on_event(
                {
                    "stage": self._stage,
                    "stage_label": STAGE_LABELS.get(self._stage, self._stage),
                    "stage_progress": round(stage_fraction, 4),
                    "progress": round(overall, 4),
                    "message": message,
                    **extra,
                }
            )
        logger.info("[%s] %s", self._stage, message)

    def callback(self) -> Callable[[float, str], None]:
        """Adaptador para as funcoes que esperam `(fracao, mensagem)`."""
        return lambda fraction, message: self.emit(fraction, message)


def run(
    source: str,
    *,
    options: PipelineOptions | None = None,
    on_event: EventFn | None = None,
) -> PipelineResult:
    """Executa a pipeline completa: URL/arquivo -> cortes verticais em disco.

    Args:
        source: URL de video ou caminho local.
        options: ajustes desta execucao.
        on_event: callback chamado a cada evento de progresso.

    Returns:
        Um `PipelineResult` com os cortes renderizados.
    """
    options = options or PipelineOptions()
    reporter = ProgressReporter(on_event)
    started = time.time()

    # ------------------------------------------------------------ 1. ingestao
    reporter.start_stage("ingest")
    media = ingest.ingest(source, on_progress=reporter.callback())
    audio_path = ingest.prepare_audio(media)
    reporter.emit(
        1.0,
        f"'{media.title}' ({media.duration / 60:.1f} min, {media.width}x{media.height})",
        media=media.to_dict(),
    )
    reporter.finish_stage("ingest")

    # -------------------------------------------------------- 2. transcricao
    reporter.start_stage("transcribe")
    transcript_path = settings.transcripts_dir / f"{Path(audio_path).parent.name}.json"

    transcript = transcriber.load_transcript(transcript_path) if options.use_cache else None
    if transcript is not None:
        reporter.emit(1.0, f"Transcricao reaproveitada do cache ({len(transcript.segments)} segmentos).")
    else:
        transcript = transcriber.transcribe(
            audio_path,
            language=options.language,
            duration_hint=media.duration,
            on_progress=reporter.callback(),
        )
        transcriber.save_transcript(transcript, transcript_path)
    reporter.emit(1.0, "Transcricao pronta.", transcript_path=str(transcript_path))
    reporter.finish_stage("transcribe")

    # ------------------------------------------------------- 3. energia audio
    reporter.start_stage("audio")
    try:
        energy = audio_energy.analyze(str(audio_path))
        reporter.emit(1.0, f"{len(energy.peaks())} picos de energia encontrados.")
    except Exception as exc:  # a energia e um sinal auxiliar; nao pode derrubar o job
        logger.warning("Analise de energia falhou: %s", exc)
        energy = None
        reporter.emit(1.0, "Analise de energia indisponivel; seguindo sem ela.")
    reporter.finish_stage("audio")

    # ----------------------------------------------------------- 4. selecao
    reporter.start_stage("analyze")
    candidates = analyzer.find_clips(
        transcript,
        energy=energy,
        video_title=media.title,
        min_clips=options.min_clips,
        max_clips=options.max_clips,
        on_progress=reporter.callback(),
    )
    reporter.emit(
        1.0,
        f"{len(candidates)} cortes selecionados.",
        candidates=[c.to_dict() for c in candidates],
    )
    reporter.finish_stage("analyze")

    if options.dry_run or not candidates:
        return PipelineResult(
            media=media,
            transcript=transcript,
            candidates=candidates,
            elapsed=time.time() - started,
            transcript_path=str(transcript_path),
        )

    # ---------------------------------------------------------- 5. render
    reporter.start_stage("render")
    clips: list[RenderedClip] = []
    total = len(candidates)

    for index, candidate in enumerate(candidates):
        base = index / total

        def stage_progress(local: float, message: str, _base: float = base) -> None:
            reporter.emit(_base + local / total, message)

        stage_progress(0.05, f"[{index + 1}/{total}] Analisando enquadramento: {candidate.title}")

        try:
            plan = reframer.build_plan(
                media.path,
                candidate.start_time,
                candidate.end_time,
                mode=options.reframe_mode,
                on_progress=lambda f, m, sp=stage_progress: sp(0.05 + f * 0.35, m),
            )

            clip = renderer.render_clip(
                media.path,
                candidate,
                plan,
                words=transcript.words_between(candidate.start_time, candidate.end_time),
                burn_subtitles=options.burn_subtitles,
                on_progress=lambda f, m, sp=stage_progress: sp(0.4 + f * 0.6, m),
            )
            clips.append(clip)

            reporter.emit(
                (index + 1) / total,
                f"[{index + 1}/{total}] Pronto: {Path(clip.video_path).name}",
                clip=clip.to_dict(),
            )
        except Exception as exc:
            # Um corte problematico (ex.: trecho sem audio) nao deve invalidar
            # o restante do lote.
            logger.exception("Falha ao renderizar '%s'", candidate.title)
            reporter.emit(
                (index + 1) / total,
                f"[{index + 1}/{total}] Falhou: {candidate.title} ({exc})",
                failed_clip=candidate.to_dict(),
            )

    reporter.finish_stage("render")

    result = PipelineResult(
        media=media,
        transcript=transcript,
        candidates=candidates,
        clips=clips,
        elapsed=time.time() - started,
        transcript_path=str(transcript_path),
    )

    manifest = settings.clips_dir / "manifest.json"
    _append_manifest(manifest, result)

    reporter.start_stage("done")
    reporter.emit(
        1.0,
        f"{len(clips)} cortes gerados em {result.elapsed / 60:.1f} min.",
        result=result.to_dict(),
    )
    return result


def _append_manifest(path: Path, result: PipelineResult) -> None:
    """Registra os cortes gerados num indice JSON que a UI consegue listar."""
    entries: list[dict[str, Any]] = []
    if path.exists():
        try:
            entries = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            logger.warning("manifest.json corrompido; recriando.")

    entries.append(
        {
            "created_at": time.time(),
            "source": result.media.source_url or result.media.path,
            "title": result.media.title,
            "clips": [c.to_dict() for c in result.clips],
        }
    )
    path.write_text(json.dumps(entries, ensure_ascii=False, indent=2), encoding="utf-8")
