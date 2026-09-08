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
