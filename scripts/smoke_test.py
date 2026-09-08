"""Teste de fumaca: valida a pipeline sem depender de rede nem de GPU.

Gera um video sintetico de 40 s com o proprio FFmpeg (padrao colorido + tom de
audio), monta um `Transcript` falso e roda as etapas puras — legenda, plano de
reframe, expressao de crop e render final. Serve para confirmar que o ambiente
esta montado antes de gastar meia hora processando uma live de verdade.

Uso:
    python scripts/smoke_test.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

# Torna `app.*` importavel a partir de /backend.
BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))

from app.config import settings  # noqa: E402
from app.core import audio_energy, reframer, renderer, subtitles  # noqa: E402
from app.models import ClipCandidate, Segment, Transcript, Word  # noqa: E402
from app.utils import ffmpeg  # noqa: E402
from app.utils.logging import setup_logging  # noqa: E402

SAMPLE_TEXT = (
    "Isso aqui e um teste do ClipForge rodando totalmente local na sua maquina "
    "com aceleracao por GPU e legenda animada palavra por palavra"
)


def make_sample_video(destination: Path, duration: int = 40) -> Path:
    """Gera um video 1920x1080 sintetico com audio, via lavfi."""
    if destination.exists():
        return destination

    destination.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg.run(
        [
            "-f", "lavfi", "-i", f"testsrc2=size=1920x1080:rate=30:duration={duration}",
            "-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-shortest",
            str(destination),
        ],
        description="video de teste",
    )
    return destination


def make_transcript(duration: float) -> Transcript:
    """Distribui as palavras de `SAMPLE_TEXT` uniformemente ao longo do video."""
    tokens = SAMPLE_TEXT.split()
    step = duration / len(tokens)

    words = [
        Word(text=token, start=index * step, end=(index + 1) * step - 0.02)
        for index, token in enumerate(tokens)
    ]

    return Transcript(
        language="pt",
        duration=duration,
        segments=[Segment(id=0, start=0.0, end=duration, text=SAMPLE_TEXT, words=words)],
    )


def main() -> int:
    setup_logging("INFO")
    settings.ensure_dirs()

    print("\n=== ClipForge :: teste de fumaca ===\n")

    if not ffmpeg.ffmpeg_available():
        print("FALHA: ffmpeg nao encontrado no PATH.")
        return 1

    encoder = ffmpeg.pick_encoder()
    print(f"[1/6] Encoder ativo: {encoder} (NVENC: {ffmpeg.has_nvenc()})")

    sample = make_sample_video(settings.cache_dir / "smoke" / "sample.mp4")
    info = ffmpeg.probe(sample)
    print(f"[2/6] Video de teste: {info.width}x{info.height}, {info.duration:.1f}s")

    energy = audio_energy.analyze(str(sample))
    print(f"[3/6] Energia do audio: {len(energy.values)} janelas, duracao {energy.duration:.1f}s")

    transcript = make_transcript(info.duration)
    ass_path = settings.cache_dir / "smoke" / "captions.ass"
    subtitles.write_ass(transcript.segments[0].words, ass_path)
    dialogues = ass_path.read_text(encoding="utf-8").count("Dialogue:")
    print(f"[4/6] Legenda .ass gerada: {dialogues} linhas animadas")

    started = time.time()
    plan = reframer.build_plan(str(sample), 5.0, 20.0)
    print(
        f"[5/6] Plano de reframe: modo={plan.mode.value}, "
        f"crop={plan.crop_width}x{plan.crop_height}, "
        f"{len(plan.keyframes)} keyframes ({time.time() - started:.1f}s)"
    )

    candidate = ClipCandidate(
        id="smoke",
        start_time=5.0,
        end_time=20.0,
        title="Teste de fumaca do ClipForge",
        virality_score=0.9,
        final_score=0.9,
        summary="Corte sintetico gerado pelo smoke_test.",
        transcript_text=SAMPLE_TEXT,
    )

    clip = renderer.render_clip(
        str(sample),
        candidate,
        plan,
        words=transcript.words_between(5.0, 20.0),
        output_path=settings.clips_dir / "smoke-test.mp4",
    )

    rendered = ffmpeg.probe(clip.video_path)
    print(
        f"[6/6] Render: {Path(clip.video_path).name} "
        f"({rendered.width}x{rendered.height}, {rendered.duration:.1f}s)"
    )

    if (rendered.width, rendered.height) != (settings.output_width, settings.output_height):
        print(
            f"\nAVISO: resolucao inesperada "
            f"({rendered.width}x{rendered.height} != "
            f"{settings.output_width}x{settings.output_height})"
        )
        return 1

    print(f"\nTudo certo. Abra: {clip.video_path}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
