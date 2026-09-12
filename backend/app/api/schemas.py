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
    # Projeto alimentado por este job; a UI abre ele quando a analise termina.
    project_id: str | None = None
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


class OllamaModelOption(BaseModel):
    """Um modelo recomendado para a selecao de cortes."""

    name: str
    label: str
    params: str
    download_gb: float
    vram_gb: float
    context: str
    tier: Literal["leve", "equilibrado", "forte"]
    note: str
    suggested_num_ctx: int
    thinking: bool = False
    installed: bool = False
    active: bool = False


class OllamaModelExtra(BaseModel):
    """Modelo ja baixado que nao esta na lista curada, mas da para usar."""

    name: str
    size_gb: float
    active: bool = False


class OllamaModelsResponse(BaseModel):
    """A vitrine de modelos, com o que esta baixado e o que esta em uso."""

    active: str
    num_ctx: int
    # False quando o Ollama nao respondeu: o catalogo aparece, sem marcacoes.
    available: bool
    models: list[OllamaModelOption] = []
    extras: list[OllamaModelExtra] = []


class OllamaModelRequest(BaseModel):
    """Escolher ou baixar um modelo pela interface."""

    model: str = Field(..., min_length=1, max_length=160)
    # Só na selecao: sobrepoe o num_ctx sugerido para o modelo.
    num_ctx: int | None = Field(default=None, ge=2048, le=131_072)


class OllamaSelection(BaseModel):
    """O que passou a valer depois da troca."""

    active: str
    num_ctx: int


class RequirementStatus(BaseModel):
    """Um item do ambiente: como esta, como consertar na mao, o que o botao roda."""

    id: str
    label: str
    summary: str
    why: str
    ok: bool
    detail: str
    tutorial: list[str] = []
    docs_url: str
    # Os comandos do plano automatico, exibidos antes de rodar.
    commands: list[str] = []
    can_install: bool = False
    # Preenchido quando outro requisito precisa ser resolvido antes deste.
    blocked_by: str | None = None
    needs_restart: bool = False


class SetupTask(BaseModel):
    """Uma instalacao disparada pela interface."""

    id: str
    requirement_id: str
    status: Literal["running", "completed", "failed"]
    log: list[str] = []
    error: str | None = None
    started_at: float
    finished_at: float | None = None
    needs_restart: bool = False


class ProjectSummary(BaseModel):
    """Um projeto na listagem: o suficiente para o card, sem o peso do resto."""

    id: str
    title: str
    source: str
    source_url: str | None = None
    status: str
    created_at: float
    updated_at: float
    clip_count: int
    candidate_count: int
    has_source: bool
    duration: float = 0.0
    thumbnail_url: str | None = None
    last_error: str | None = None


class ProjectDetail(BaseModel):
    """Projeto completo: trechos analisados e cortes gerados."""

    id: str
    title: str
    source: str
    source_url: str | None = None
    status: str
    created_at: float
    updated_at: float
    media: dict[str, Any] | None = None
    candidates: list[dict[str, Any]] = []
    clips: list[dict[str, Any]] = []
    has_source: bool = False
    clip_count: int = 0
    candidate_count: int = 0
    transcript_path: str | None = None
    last_error: str | None = None


class ProjectRenameRequest(BaseModel):
    """Renomear um projeto pela interface."""

    title: str = Field(..., min_length=1, max_length=120)


class ClipListResponse(BaseModel):
    """Cortes ja renderizados que existem no disco."""

    clips: list[dict[str, Any]]


AspectRatioLiteral = Literal["9:16", "4:5", "1:1", "16:9"]
ReframeModeLiteral = Literal[
    "auto", "single", "split", "center", "manual", "keyframe", "composite"
]


class LayoutRegionInput(BaseModel):
    """Uma faixa do layout composto, em fracoes do frame de origem (0-1)."""

    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    width: float = Field(..., gt=0.0, le=1.0)
    height: float = Field(..., gt=0.0, le=1.0)
    weight: float = Field(default=0.5, gt=0.0, le=1.0)
    label: str = ""


class CameraKeyframeInput(BaseModel):
    """Onde a camera aponta num instante do corte.

    `x` e `y` sao o CENTRO do enquadramento em fracoes do frame de origem, nao
    o canto: e assim que a interface pensa, e o backend converte.
    """

    t: float = Field(..., ge=0, description="Segundos desde o inicio do corte.")
    x: float = Field(..., ge=0.0, le=1.0)
    y: float = Field(..., ge=0.0, le=1.0)
    # True corta seco aqui; False desliza desde o ponto anterior.
    hold: bool = True


SubtitlePresetLiteral = Literal["karaoke", "word", "block", "clean"]


class SubtitleStyle(BaseModel):
    """Ajustes de legenda escolhidos por corte na interface."""

    font_size: int = Field(default=84, ge=24, le=200)
    preset: SubtitlePresetLiteral = Field(
        default="karaoke",
        description=(
            "Tipo da legenda: 'karaoke' destaca a palavra falada em cor, 'word' "
            "mostra uma palavra por vez, 'block' poe uma caixa opaca atras do "
            "texto e 'clean' usa so contorno grosso, sem destaque colorido."
        ),
    )
    # Posicao livre do texto, em fracoes da saida. Quando vem, manda no lugar
    # do `margin_v`.
    pos_x: float | None = Field(default=None, ge=0.0, le=1.0)
    pos_y: float | None = Field(default=None, ge=0.0, le=1.0)
    # Distancia da legenda ate a base do video, em pixels da saida.
    margin_v: int = Field(default=420, ge=0, le=1600)
    # Cores em `#RRGGBB`; o backend converte para o BGR que o ASS espera.
    primary_color: str = "#FFFFFF"
    highlight_color: str = "#FFE500"
    max_words: int = Field(default=4, ge=1, le=10)


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
    camera_keyframes: list[CameraKeyframeInput] | None = Field(
        default=None,
        max_length=60,
        description=(
            "Posicoes da camera ao longo do corte. Exigido no modo 'keyframe'; "
            "entre dois pontos a janela desliza, ou salta quando o seguinte "
            "pede corte seco."
        ),
    )
    zoom: float = Field(
        default=1.0,
        ge=1.0,
        le=4.0,
        description=(
            "Fecha o enquadramento: 1.0 e a maior janela que cabe, 2.0 pega "
            "metade da largura. Constante no corte inteiro."
        ),
    )
    burn_subtitles: bool = True
    subtitle_style: SubtitleStyle | None = None


class RenderResponse(BaseModel):
    """Cortes renderizados, um por formato pedido."""

    clips: list[dict[str, Any]]


class WordsResponse(BaseModel):
    """Palavras do trecho, para a previa desenhar a legenda ao vivo."""

    words: list[dict[str, Any]]


class SuggestionResponse(BaseModel):
    """Layout e formato que a analise recomenda para um trecho."""

    mode: str
    aspect_ratio: str
    reason: str
    confidence: float
    regions: list[dict[str, Any]] = []
    faces_detected: int = 0
