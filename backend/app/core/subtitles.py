"""Geracao de legendas `.ass` animadas palavra-a-palavra.

O estilo "TikTok" — poucas palavras na tela, a palavra falada agora destacada em
outra cor e levemente maior — depende de duas coisas: timestamps por palavra
(vindos do Whisper) e um formato de legenda com controle de estilo inline. O SRT
nao tem isso; o ASS (Advanced SubStation Alpha) tem, e o FFmpeg o queima no
video com o filtro `subtitles`.

Tecnica usada: cada grupo de palavras vira varios `Dialogue`, um por palavra
falada, todos com o mesmo texto mas com a palavra da vez destacada por tags
inline. E mais verboso que karaoke `\\k`, porem funciona igual em qualquer
versao do libass e permite animar tamanho e cor juntos.
"""

from __future__ import annotations

import re
from pathlib import Path

from app.config import settings
from app.models import Word

# Cabecalho ASS. PlayResX/Y definem o espaco de coordenadas do estilo: usamos a
# resolucao final de saida para que tamanhos de fonte sejam em pixels reais.
_HEADER = """[Script Info]
ScriptType: v4.00+
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709
PlayResX: {width}
PlayResY: {height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,{font},{size},{primary},{primary},{outline},&H80000000,-1,0,0,0,100,100,0,0,1,{border},{shadow},2,{margin_h},{margin_h},{margin_v},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def _timestamp(seconds: float) -> str:
    """Converte segundos para o formato `H:MM:SS.cc` exigido pelo ASS."""
    seconds = max(0.0, seconds)
    centiseconds = int(round(seconds * 100))
    hours, centiseconds = divmod(centiseconds, 360_000)
    minutes, centiseconds = divmod(centiseconds, 6_000)
    secs, centiseconds = divmod(centiseconds, 100)
    return f"{hours:d}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"


def _escape(text: str) -> str:
    """Neutraliza os caracteres com significado especial no corpo do ASS."""
    return (
        text.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\n", " ")
        .strip()
    )


def group_words(
    words: list[Word],
    *,
    max_words: int | None = None,
    max_gap: float = 0.7,
) -> list[list[Word]]:
    """Agrupa palavras em "cartoes" de legenda.

    Um cartao fecha quando: atinge o limite de palavras, aparece uma pontuacao
    final, ou ha uma pausa longa na fala (que quase sempre marca fim de frase).
    """
    max_words = max_words or settings.subtitle_max_words_per_line
    groups: list[list[Word]] = []
    current: list[Word] = []

    for index, word in enumerate(words):
        current.append(word)

        is_last = index == len(words) - 1
        hit_limit = len(current) >= max_words
        ends_sentence = bool(re.search(r"[.!?,;:]$", word.text.strip()))
        long_pause = (
            not is_last and (words[index + 1].start - word.end) > max_gap
        )

        if is_last or hit_limit or ends_sentence or long_pause:
            groups.append(current)
            current = []

    if current:
        groups.append(current)

    return groups


def build_ass(
    words: list[Word],
    *,
    time_offset: float = 0.0,
    width: int | None = None,
    height: int | None = None,
    max_words: int | None = None,
) -> str:
    """Monta o conteudo de um arquivo `.ass` com destaque palavra-a-palavra.

    Args:
        words: palavras com timestamps absolutos do video original.
        time_offset: inicio do corte; subtraido de cada timestamp para que a
            legenda comece em zero no clipe recortado.
        width / height: resolucao de saida (padrao: a do `.env`).
        max_words: palavras por cartao (padrao: a do `.env`).

    Returns:
        O texto completo do arquivo ASS.
    """
    width = width or settings.output_width
    height = height or settings.output_height

    lines = [
        _HEADER.format(
            width=width,
            height=height,
            font=settings.subtitle_font,
            size=settings.subtitle_font_size,
            primary=settings.subtitle_primary_color,
            outline=settings.subtitle_outline_color,
            border=max(3, settings.subtitle_font_size // 16),
            shadow=2,
            margin_h=int(width * 0.08),
            margin_v=settings.subtitle_margin_v,
        )
    ]

    highlight = settings.subtitle_highlight_color

    for group in group_words(words, max_words=max_words):
        if not group:
            continue

        for position, spoken in enumerate(group):
            start = max(0.0, spoken.start - time_offset)
            # O cartao segue na tela ate a proxima palavra; na ultima, estica um
            # pouco para o texto nao sumir junto com o audio.
            if position + 1 < len(group):
                end = max(start, group[position + 1].start - time_offset)
            else:
                end = max(start, spoken.end - time_offset + 0.25)

            if end <= start:
                continue

            rendered: list[str] = []
            for index, word in enumerate(group):
                text = _escape(word.text)
                if index == position:
                    # Palavra atual: cor de destaque + um "pop" de escala.
                    rendered.append(
                        rf"{{\c{highlight}\fscx112\fscy112\bord{max(4, settings.subtitle_font_size // 14)}}}"
                        rf"{text}"
                        rf"{{\c{settings.subtitle_primary_color}\fscx100\fscy100\bord{max(3, settings.subtitle_font_size // 16)}}}"
                    )
                else:
                    rendered.append(text)

            body = " ".join(rendered)
            # Fade de 60 ms nas bordas evita o "piscar" entre cartoes.
            lines.append(
                f"Dialogue: 0,{_timestamp(start)},{_timestamp(end)},Default,,0,0,0,,"
                rf"{{\fad(60,60)}}{body}"
            )

    return "\n".join(lines) + "\n"


def write_ass(
    words: list[Word],
    destination: str | Path,
    *,
    time_offset: float = 0.0,
    **kwargs,
) -> Path:
    """Grava o arquivo `.ass` em disco e devolve o caminho."""
    destination = Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(
        build_ass(words, time_offset=time_offset, **kwargs),
        encoding="utf-8",
    )
    return destination
