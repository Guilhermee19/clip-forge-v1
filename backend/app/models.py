"""Estruturas de dados compartilhadas por toda a pipeline.

Usamos dataclasses (e nao modelos Pydantic) nos modulos de processamento para
manter o nucleo leve e independente do framework web. A camada de API converte
essas dataclasses para JSON via `to_dict()`.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any


# ===========================================================================
# Transcricao
# ===========================================================================


@dataclass(slots=True)
class Word:
    """Uma palavra transcrita com timestamp proprio (usada nas legendas)."""

    text: str
    start: float
    end: float
    probability: float = 1.0

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class Segment:
    """Um trecho continuo de fala retornado pelo Whisper."""

    id: int
    start: float
    end: float
    text: str
    words: list[Word] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "words": [w.to_dict() for w in self.words],
        }


@dataclass(slots=True)
class Transcript:
    """Transcricao completa de um video."""

    language: str
    duration: float
    segments: list[Segment] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(s.text.strip() for s in self.segments).strip()

    def words_between(self, start: float, end: float) -> list[Word]:
        """Todas as palavras cujo centro cai dentro de [start, end]."""
        out: list[Word] = []
        for segment in self.segments:
            if segment.end < start or segment.start > end:
                continue
            for word in segment.words:
                center = (word.start + word.end) / 2
                if start <= center <= end:
                    out.append(word)
        return out

    def text_between(self, start: float, end: float) -> str:
        """Texto falado dentro da janela, reconstruido a partir dos segmentos."""
        parts = [
            s.text.strip()
            for s in self.segments
            if s.end > start and s.start < end
        ]
        return " ".join(parts).strip()

    def to_dict(self) -> dict[str, Any]:
        return {
            "language": self.language,
            "duration": self.duration,
            "segments": [s.to_dict() for s in self.segments],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> Transcript:
        return cls(
            language=data["language"],
            duration=data["duration"],
            segments=[
                Segment(
                    id=s["id"],
                    start=s["start"],
                    end=s["end"],
                    text=s["text"],
                    words=[Word(**w) for w in s.get("words", [])],
                )
                for s in data.get("segments", [])
            ],
        )


# ===========================================================================
# Selecao de cortes
# ===========================================================================


@dataclass(slots=True)
class ClipCandidate:
    """Um corte proposto pelo analisador, antes de virar arquivo de video."""

    id: str
    start_time: float
    end_time: float
    title: str
    virality_score: float
    summary: str = ""
    transcript_text: str = ""
    hook: str = ""
    reason: str = ""
    tags: list[str] = field(default_factory=list)
    # Score bruto de energia do audio (0-1) no intervalo, antes da fusao.
    audio_score: float = 0.0
    # Score final = mistura do score do LLM com o score de audio.
    final_score: float = 0.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end_time - self.start_time)

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["duration"] = self.duration
        return data


# ===========================================================================
# Reframe 9:16
# ===========================================================================


class ReframeMode(str, Enum):
    """Estrategia de enquadramento escolhida para um corte."""

    SINGLE = "single"        # uma camera virtual seguindo o falante
    SPLIT = "split"          # duas pessoas empilhadas (split-screen vertical)
    CENTER = "center"        # crop fixo no centro (sem rosto detectado)
    MANUAL = "manual"        # posicao horizontal escolhida a mao na UI
    KEYFRAME = "keyframe"    # camera movida a mao ao longo do tempo, na UI
    COMPOSITE = "composite"  # varias regioes do frame empilhadas (gameplay + webcam)


class AspectRatio(str, Enum):
    """Formatos de saida oferecidos pela interface.

    A altura de referencia e sempre 1920 nos verticais, o que mantem a legenda
    e o texto com o mesmo tamanho relativo entre os formatos.
    """

    VERTICAL = "9:16"    # TikTok, Reels, Shorts
    PORTRAIT = "4:5"     # feed do Instagram
    SQUARE = "1:1"       # feed generico
    LANDSCAPE = "16:9"   # YouTube tradicional

    @property
    def ratio(self) -> float:
        width, _, height = self.value.partition(":")
        return int(width) / int(height)

    def size(self, base_height: int = 1920) -> tuple[int, int]:
        """Resolucao de saida do formato, com ambos os lados pares."""
        if self is AspectRatio.LANDSCAPE:
            # Deitado: 1920 vira a largura, senao o arquivo fica gigante.
            width, height = 1920, 1080
        else:
            height = base_height
            width = int(round(height * self.ratio / 2) * 2)
        return width, height


@dataclass(slots=True)
class CropKeyframe:
    """Posicao da janela de crop num instante do tempo.

    `x` e `y` sao o canto superior esquerdo da janela, em pixels do video
    original. A largura/altura da janela ficam no `ReframePlan`.
    """

    t: float
    x: float
    y: float
    # True corta seco neste ponto: a janela fica parada no valor anterior e
    # salta aqui. False (padrao) desliza suavemente desde o keyframe anterior.
    hold: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class LayoutRegion:
    """Uma faixa da composicao vertical.

    Diz *de onde* recortar no video original e *quanto* da altura final aquela
    faixa ocupa. E o que permite montar o layout classico de corte de gameplay:
    o jogo numa faixa, a webcam na outra.

    As coordenadas sao fracoes do frame de origem (0-1), nao pixels, para que a
    mesma regiao valha em qualquer resolucao.
    """

    x: float
    y: float
    width: float
    height: float
    # Fracao da altura de saida ocupada por esta faixa. As fracoes somam 1.0.
    weight: float = 0.5
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def pixels(self, source_width: int, source_height: int) -> tuple[int, int, int, int]:
        """Converte para `(x, y, largura, altura)` em pixels pares e dentro do frame."""

        def even(value: float) -> int:
            return max(2, int(round(value / 2) * 2))

        w = even(min(self.width, 1.0) * source_width)
        h = even(min(self.height, 1.0) * source_height)
        x = int(round(max(0.0, min(self.x, 1.0)) * source_width))
        y = int(round(max(0.0, min(self.y, 1.0)) * source_height))

        # Nao deixa a janela vazar pela borda direita/inferior.
        x = min(x, max(0, source_width - w))
        y = min(y, max(0, source_height - h))
        return x, y, w, h


@dataclass(slots=True)
class ReframePlan:
    """Plano completo de reenquadramento de um corte."""

    mode: ReframeMode
    source_width: int
    source_height: int
    crop_width: int
    crop_height: int
    keyframes: list[CropKeyframe] = field(default_factory=list)
    # Para o modo split: a segunda janela (a de cima e `keyframes`).
    keyframes_secondary: list[CropKeyframe] = field(default_factory=list)
    # Para o modo composite: as faixas empilhadas, de cima para baixo.
    regions: list[LayoutRegion] = field(default_factory=list)
    faces_detected: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode.value,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "crop_width": self.crop_width,
            "crop_height": self.crop_height,
            "keyframes": [k.to_dict() for k in self.keyframes],
            "keyframes_secondary": [k.to_dict() for k in self.keyframes_secondary],
            "regions": [r.to_dict() for r in self.regions],
            "faces_detected": self.faces_detected,
        }


@dataclass(slots=True)
class LayoutSuggestion:
    """O que a analise recomenda para um corte, antes de o usuario decidir."""

    mode: str
    aspect_ratio: str
    reason: str
    confidence: float
    regions: list[LayoutRegion] = field(default_factory=list)
    faces_detected: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "mode": self.mode,
            "aspect_ratio": self.aspect_ratio,
            "reason": self.reason,
            "confidence": round(self.confidence, 3),
            "regions": [r.to_dict() for r in self.regions],
            "faces_detected": self.faces_detected,
        }


# ===========================================================================
# Resultado final
# ===========================================================================


@dataclass(slots=True)
class RenderedClip:
    """Um corte ja renderizado em disco."""

    candidate: ClipCandidate
    video_path: str
    subtitle_path: str | None
    thumbnail_path: str | None
    width: int
    height: int
    duration: float
    reframe_mode: str

    def to_dict(self) -> dict[str, Any]:
        return {
            **self.candidate.to_dict(),
            "video_path": self.video_path,
            "subtitle_path": self.subtitle_path,
            "thumbnail_path": self.thumbnail_path,
            "width": self.width,
            "height": self.height,
            "rendered_duration": self.duration,
            "reframe_mode": self.reframe_mode,
        }


@dataclass(slots=True)
class MediaInfo:
    """Metadados da midia de entrada, lidos com ffprobe."""

    path: str
    title: str
    duration: float
    width: int
    height: int
    fps: float
    has_audio: bool
    source_url: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
