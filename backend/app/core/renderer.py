"""Etapa 5 da pipeline: montagem e renderizacao final com FFmpeg + NVENC.

Tudo acontece numa unica passada do FFmpeg: recorte temporal, crop animado da
camera virtual, escala para 1080x1920, queima da legenda e encode em NVENC. Uma
passada so evita gerar arquivos intermediarios de varios GB e mantem a
qualidade (nada de reencode duplo).

A camera virtual e expressa como uma *expressao* do filtro `crop`: o FFmpeg
avalia `x` a cada frame em funcao de `t`, interpolando linearmente entre os
keyframes que o `reframer` produziu.
"""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from app.config import settings
from app.core import subtitles as subtitles_module
from app.models import ClipCandidate, CropKeyframe, ReframeMode, ReframePlan, RenderedClip, Word
from app.utils import ffmpeg
from app.utils.logging import get_logger

logger = get_logger(__name__)

ProgressFn = Callable[[float, str], None]


# ---------------------------------------------------------------------------
# Expressao de crop animado
# ---------------------------------------------------------------------------


def build_crop_expression(keyframes: list[CropKeyframe], *, fallback: float = 0.0) -> str:
    """Converte keyframes numa expressao de `t` para o filtro `crop` do FFmpeg.

    A saida e uma cadeia de `if(lt(t,T), <interpolacao linear>, <resto>)`. Com a
    simplificacao feita no reframer, sobram algumas dezenas de termos — bem
    dentro do que o parser de expressoes do FFmpeg aguenta.

    Args:
        keyframes: pontos ordenados por tempo, com `t` relativo ao inicio do corte.
        fallback: valor usado quando nao ha keyframe algum.

    Returns:
        Uma expressao pronta para `crop=x='...'`.
    """
    if not keyframes:
        return f"{fallback:.1f}"
    if len(keyframes) == 1:
        return f"{keyframes[0].x:.1f}"

    # Constroi de tras para frente: o "senao" de cada nivel e o nivel seguinte.
    expression = f"{keyframes[-1].x:.1f}"

    for current, following in zip(reversed(keyframes[:-1]), reversed(keyframes[1:]), strict=True):
        span = max(following.t - current.t, 1e-3)
        slope = (following.x - current.x) / span
        segment = f"({current.x:.1f}+{slope:.4f}*(t-{current.t:.3f}))"
        expression = f"if(lt(t,{following.t:.3f}),{segment},{expression})"

    return expression


# ---------------------------------------------------------------------------
# Filtergraph
# ---------------------------------------------------------------------------


def _composite_chain(
    plan: ReframePlan, out_w: int, out_h: int, fps: int, scale_flags: str
) -> str:
    """Empilha as faixas do layout composto (ex.: gameplay em cima, webcam embaixo).

    Cada faixa e recortada do frame original e escalada para a altura que lhe
    cabe. A regiao que o usuario desenha tem proporcao arbitraria, entao usamos
    `force_original_aspect_ratio=increase` seguido de um crop: a faixa preenche
    o espaco inteiro e o excedente e aparado, em vez de a imagem esticar.
    """
    regions = plan.regions
    count = len(regions)

    # Alturas pares que somam exatamente `out_h` — a ultima faixa absorve a
    # sobra do arredondamento, senao o vstack recusa a altura final.
    heights: list[int] = []
    for index, region in enumerate(regions):
        if index == count - 1:
            heights.append(out_h - sum(heights))
        else:
            heights.append(max(2, int(round(out_h * region.weight / 2) * 2)))

    parts = [f"[0:v]split={count}" + "".join(f"[src{i}]" for i in range(count)) + ";"]

    for index, (region, band_height) in enumerate(zip(regions, heights, strict=True)):
        x, y, w, h = region.pixels(plan.source_width, plan.source_height)
        parts.append(
            f"[src{index}]crop={w}:{h}:{x}:{y},"
            f"scale={out_w}:{band_height}:{scale_flags}:force_original_aspect_ratio=increase,"
            f"crop={out_w}:{band_height},setsar=1[band{index}];"
        )

    parts.append("".join(f"[band{i}]" for i in range(count)))
    parts.append(f"vstack=inputs={count}[stacked];")
    parts.append(f"[stacked]fps={fps},format=yuv420p")

    return "".join(parts)


def build_filter_complex(
    plan: ReframePlan,
    *,
    subtitle_file: str | None,
    output_size: tuple[int, int] | None = None,
) -> str:
    """Monta o `filter_complex` completo para um corte.

    O rotulo de saida e sempre `[v]`.
    """
    out_w, out_h = output_size or (settings.output_width, settings.output_height)
    fps = settings.output_fps
    scale_flags = "flags=lanczos"

    if plan.mode is ReframeMode.COMPOSITE and plan.regions:
        chain = _composite_chain(plan, out_w, out_h, fps, scale_flags)

    elif plan.mode is ReframeMode.SPLIT:
        top = build_crop_expression(plan.keyframes)
        bottom = build_crop_expression(plan.keyframes_secondary)
        y = plan.keyframes[0].y if plan.keyframes else 0.0
        panel_h = out_h // 2

        chain = (
            f"[0:v]split=2[src_top][src_bottom];"
            f"[src_top]crop={plan.crop_width}:{plan.crop_height}:x='{top}':y={y:.1f},"
            f"scale={out_w}:{panel_h}:{scale_flags},setsar=1[panel_top];"
            f"[src_bottom]crop={plan.crop_width}:{plan.crop_height}:x='{bottom}':y={y:.1f},"
            f"scale={out_w}:{panel_h}:{scale_flags},setsar=1[panel_bottom];"
            f"[panel_top][panel_bottom]vstack=inputs=2[stacked];"
            f"[stacked]fps={fps},format=yuv420p"
        )
    else:
        x = build_crop_expression(plan.keyframes)
        y = plan.keyframes[0].y if plan.keyframes else 0.0
        chain = (
            f"[0:v]crop={plan.crop_width}:{plan.crop_height}:x='{x}':y={y:.1f},"
            f"scale={out_w}:{out_h}:{scale_flags},setsar=1,"
            f"fps={fps},format=yuv420p"
        )

    if subtitle_file:
        # O processo roda com cwd na pasta da legenda, entao basta o nome do
        # arquivo — sem barras nem `C:` para o filtergraph interpretar errado.
        chain += f",ass=filename={subtitle_file}"

    return chain + "[v]"


# ---------------------------------------------------------------------------
# Renderizacao
# ---------------------------------------------------------------------------


def render_clip(
    source: str | Path,
    candidate: ClipCandidate,
    plan: ReframePlan,
    *,
    words: list[Word] | None = None,
    output_path: str | Path | None = None,
    burn_subtitles: bool | None = None,
    make_thumbnail: bool = True,
    output_size: tuple[int, int] | None = None,
    subtitle_style: dict | None = None,
    on_progress: ProgressFn | None = None,
) -> RenderedClip:
    """Renderiza um corte vertical completo.

    Args:
        source: video de origem.
        candidate: trecho escolhido (define o recorte temporal e o nome do arquivo).
        plan: plano de reenquadramento vindo do `reframer`.
        words: palavras com timestamps absolutos, para a legenda animada.
        output_path: destino; padrao e `output/clips/<indice>-<slug>.mp4`.
        burn_subtitles: sobrescreve a opcao do `.env`.
        make_thumbnail: se deve extrair um JPEG de capa.
        output_size: `(largura, altura)` da saida. `None` usa a do `.env`.
        subtitle_style: ajustes da legenda vindos da UI (tamanho, margem, cores).
        on_progress: callback `(fracao, mensagem)`.

    Returns:
        Um `RenderedClip` com os caminhos dos arquivos gerados.
    """
    burn = settings.burn_subtitles if burn_subtitles is None else burn_subtitles
    out_w, out_h = output_size or (settings.output_width, settings.output_height)
    duration = candidate.duration

    if output_path is None:
        output_path = settings.clips_dir / f"{_slug(candidate.title)}-{candidate.id}.mp4"
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    # A legenda vive num diretorio temporario que vira o cwd do FFmpeg.
    work_dir = Path(tempfile.mkdtemp(prefix="clipforge-"))
    subtitle_file: str | None = None
    saved_subtitle: Path | None = None

    try:
        if burn and words:
            subtitle_file = "captions.ass"
            subtitles_module.write_ass(
                words,
                work_dir / subtitle_file,
                time_offset=candidate.start_time,
                width=out_w,
                height=out_h,
                **(subtitle_style or {}),
            )
            # Guarda uma copia ao lado do video, para reedicao manual depois.
            saved_subtitle = output_path.with_suffix(".ass")
            shutil.copy2(work_dir / subtitle_file, saved_subtitle)

        encoder = ffmpeg.pick_encoder()
        filter_complex = build_filter_complex(
            plan, subtitle_file=subtitle_file, output_size=(out_w, out_h)
        )

        args = [
            # `-ss` antes de `-i` faz o seek pelo demuxer: em um video de 3 h a
            # diferenca e de minutos por corte.
            "-ss", f"{candidate.start_time:.3f}",
            "-t", f"{duration:.3f}",
            "-i", str(Path(source).resolve()),
            "-filter_complex", filter_complex,
            "-map", "[v]",
            "-map", "0:a?",
            "-c:v", encoder,
            *ffmpeg.encoder_quality_args(encoder),
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", settings.audio_bitrate,
            "-ac", "2",
            "-movflags", "+faststart",
            str(output_path.resolve()),
        ]

        logger.info(
            "Renderizando '%s' (%.1fs, %dx%d, modo=%s, encoder=%s)",
            candidate.title,
            duration,
            out_w,
            out_h,
            plan.mode.value,
            encoder,
        )

        ffmpeg.run(
            args,
            total_duration=duration,
            on_progress=(
                (lambda f: on_progress(f, f"Renderizando... {f * 100:.0f}%"))
                if on_progress
                else None
            ),
            description=f"render '{candidate.title[:40]}'",
            cwd=work_dir,
        )

        thumbnail: Path | None = None
        if make_thumbnail:
            try:
                thumbnail = ffmpeg.grab_thumbnail(
                    output_path,
                    output_path.with_suffix(".jpg"),
                    timestamp=min(1.0, duration / 3),
                )
            except ffmpeg.FFmpegError as exc:
                logger.warning("Thumbnail falhou para %s: %s", output_path.name, exc)

        return RenderedClip(
            candidate=candidate,
            video_path=str(output_path),
            subtitle_path=str(saved_subtitle) if saved_subtitle else None,
            thumbnail_path=str(thumbnail) if thumbnail else None,
            width=out_w,
            height=out_h,
            duration=duration,
            reframe_mode=plan.mode.value,
        )

    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def _slug(text: str, max_length: int = 48) -> str:
    """Nome de arquivo seguro derivado do titulo do corte."""
    import re

    slug = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    slug = re.sub(r"[\s_-]+", "-", slug)
    return slug[:max_length].strip("-") or "clip"
