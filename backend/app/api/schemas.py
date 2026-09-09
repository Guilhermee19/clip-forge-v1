"""Modelos Pydantic da API (contratos de entrada e saida)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class JobCreateRequest(BaseModel):
    """Corpo do POST /api/jobs."""

    source: str = Field(
        ...,
        description="URL de video (YouTube/Twitch) ou caminho de arquivo local.",
        examples=["https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    )
    min_clips: int | None = Field(default=None, ge=1, le=50)
    max_clips: int | None = Field(default=None, ge=1, le=50)
    language: str | None = Field(default=None, description="Codigo ISO, ex.: 'pt'.")
    reframe_mode: Literal["auto", "single", "split", "center"] | None = None
    burn_subtitles: bool | None = None
    use_cache: bool = True
    dry_run: bool = Field(
        default=False,
        description="Seleciona os cortes mas nao renderiza (util para revisar antes).",
    )


class JobSummary(BaseModel):
    """Estado de um job, como devolvido pelos endpoints de consulta."""

    id: str
    source: str
    status: str
    progress: float
    stage: str
    message: str
    created_at: float
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    clips: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    result: dict[str, Any] | None = None
    media: dict[str, Any] | None = None
    # True quando o video de origem ainda esta no disco, ou seja, a previa e a
    # re-renderizacao de cortes editados estao disponiveis.
    has_source: bool = False


class HealthResponse(BaseModel):
    """Diagnostico do ambiente local, exibido na UI antes do primeiro job."""

    status: Literal["ok", "degraded"]
    version: str
    ffmpeg: bool
    nvenc: bool
    encoder: str
    whisper_device: str
    whisper_model: str
    llm_provider: str
    llm_ok: bool
    llm_message: str
    output_dir: str


class ClipListResponse(BaseModel):
    """Cortes ja renderizados que existem no disco."""

    clips: list[dict[str, Any]]


AspectRatioLiteral = Literal["9:16", "4:5", "1:1", "16:9"]
ReframeModeLiteral = Literal["auto", "single", "split", "center", "manual", "composite"]


class LayoutRegionInput(BaseModel):
    """Uma faixa do layout composto, em fracoes do frame de origem (0-1)."""

    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    width: float = Field(..., gt=0.0, le=1.0)
    height: float = Field(..., gt=0.0, le=1.0)
    weight: float = Field(default=0.5, gt=0.0, le=1.0)
    label: str = ""


class RenderRequest(BaseModel):
    """Pedido para renderizar um corte com os ajustes feitos na interface.

    Tudo aqui e opcional exceto o intervalo: o que nao vier usa o padrao.
    Passar mais de um formato em `aspect_ratios` gera um arquivo para cada um,
    reaproveitando a mesma analise de enquadramento.
    """

    start_time: float = Field(..., ge=0, description="Inicio do corte, em segundos.")
    end_time: float = Field(..., gt=0, description="Fim do corte, em segundos.")
    title: str | None = Field(default=None, max_length=120)
    aspect_ratios: list[AspectRatioLiteral] = Field(
        default=["9:16"],
        min_length=1,
        max_length=4,
        description="Um arquivo e gerado para cada formato desta lista.",
    )
    reframe_mode: ReframeModeLiteral = "auto"
    manual_offset: float | None = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "Posicao horizontal do enquadramento quando reframe_mode='manual': "
            "0 encosta na esquerda, 1 na direita, 0.5 centraliza."
        ),
    )
    regions: list[LayoutRegionInput] | None = Field(
        default=None,
        description="Faixas empilhadas, de cima para baixo. Exigido no modo 'composite'.",
    )
    burn_subtitles: bool = True


class RenderResponse(BaseModel):
    """Cortes renderizados, um por formato pedido."""

    clips: list[dict[str, Any]]


class SuggestionResponse(BaseModel):
    """Layout e formato que a analise recomenda para um trecho."""

    mode: str
    aspect_ratio: str
    reason: str
    confidence: float
    regions: list[dict[str, Any]] = []
    faces_detected: int = 0
