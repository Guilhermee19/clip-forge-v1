"""Servidor FastAPI: REST para controlar jobs, WebSocket para o progresso.

Subir com:

    uvicorn app.api.server:app --reload --port 8000     (a partir de /backend)

ou, mais simples:

    python backend/cli.py serve
"""

from __future__ import annotations

import asyncio
import json
import shutil
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import jobs as jobs_module
from app.api.schemas import (
    ClipListResponse,
    HealthResponse,
    JobCreateRequest,
    JobSummary,
    OllamaModelRequest,
    OllamaModelsResponse,
    OllamaSelection,
    ProjectDetail,
    ProjectRenameRequest,
    ProjectSummary,
    RenderRequest,
    RenderResponse,
    RequirementStatus,
    SetupTask,
    SuggestionResponse,
    WordsResponse,
)
from app.config import settings
from app.core import (
    analyzer,
    ingest,
    ollama_models,
    projects,
    reframer,
    renderer,
    setup_doctor,
    subtitles,
    transcriber,
)
from app.core.pipeline import PipelineOptions
from app.models import AspectRatio, ClipCandidate, LayoutRegion
from app.utils import ffmpeg
from app.utils.cuda import resolve_device
from app.utils.logging import get_logger, setup_logging

logger = get_logger(__name__)

manager = jobs_module.manager

# Estados em que nao virao mais eventos: o WebSocket encerra em vez de esperar.
_TERMINAL_STATUSES = {
    jobs_module.JobStatus.COMPLETED,
    jobs_module.JobStatus.FAILED,
    jobs_module.JobStatus.CANCELLED,
}


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Liga o event loop ao gerenciador de jobs e limpa tudo no shutdown."""
    setup_logging(settings.log_level)
    settings.ensure_dirs()
    manager.bind_loop(asyncio.get_running_loop())

    # Converte o formato antigo (pasta unica de cortes) em projetos. Roda uma
    # vez: depois o manifesto fica marcado como migrado.
    migrated = projects.migrate_legacy()
    if migrated:
        logger.info("%d projeto(s) importados do formato antigo.", migrated)

    logger.info("ClipForge %s pronto em http://%s:%s", __version__, settings.api_host, settings.api_port)
    yield

    manager.shutdown()


app = FastAPI(
    title="ClipForge API",
    description="Gera cortes verticais automaticos a partir de videos longos, 100% local.",
    version=__version__,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve os cortes de todos os projetos: /media/<projeto>/clips/<arquivo>.
app.mount("/media", StaticFiles(directory=str(projects.projects_dir())), name="media")


# ---------------------------------------------------------------------------
# Diagnostico
# ---------------------------------------------------------------------------


@app.get("/api/health", response_model=HealthResponse, tags=["sistema"])
def health() -> HealthResponse:
    """Checa ffmpeg, NVENC, dispositivo do Whisper e o LLM configurado."""
    has_ffmpeg = ffmpeg.ffmpeg_available()
    has_nvenc = ffmpeg.has_nvenc() if has_ffmpeg else False
    llm_ok, llm_message = analyzer.check_llm()

    return HealthResponse(
        status="ok" if (has_ffmpeg and llm_ok) else "degraded",
        version=__version__,
        ffmpeg=has_ffmpeg,
        nvenc=has_nvenc,
        encoder=ffmpeg.pick_encoder() if has_ffmpeg else "indisponivel",
        whisper_device=resolve_device(settings.whisper_device),
        whisper_model=settings.whisper_model,
        llm_provider=settings.llm_provider,
        llm_ok=llm_ok,
        llm_message=llm_message,
        output_dir=str(settings.clips_dir),
    )


# ---------------------------------------------------------------------------
# Preparacao do ambiente
# ---------------------------------------------------------------------------


@app.get("/api/setup/requirements", response_model=list[RequirementStatus], tags=["sistema"])
def setup_requirements() -> list[RequirementStatus]:
    """O que o ambiente precisa, o que ja tem, e como resolver o que falta."""
    return [RequirementStatus(**item) for item in setup_doctor.status()]


@app.post(
    "/api/setup/install/{requirement_id}",
    response_model=SetupTask,
    status_code=202,
    tags=["sistema"],
)
def setup_install(requirement_id: str) -> SetupTask:
    """Roda o plano de instalacao daquele requisito.

    Os comandos vivem fixos em `core/setup_doctor.py`: o `requirement_id` so
    escolhe qual plano rodar, nunca vira argumento de shell.
    """
    running = setup_doctor.running_for(requirement_id)
    if running is not None:
        raise HTTPException(status_code=409, detail="Essa instalacao ja esta rodando.")

    try:
        task = setup_doctor.start_install(requirement_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Requisito desconhecido.") from None
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None

    return SetupTask(**task.to_dict())


@app.get("/api/setup/models", response_model=OllamaModelsResponse, tags=["sistema"])
def list_ollama_models() -> OllamaModelsResponse:
    """Modelos recomendados para escolher os cortes, com o estado de cada um."""
    return OllamaModelsResponse(**ollama_models.options())


@app.post("/api/setup/models/select", response_model=OllamaSelection, tags=["sistema"])
def select_ollama_model(payload: OllamaModelRequest) -> OllamaSelection:
    """Troca o modelo em uso, gravando no `.env` e na configuracao em memoria."""
    try:
        return OllamaSelection(**ollama_models.select(payload.model, num_ctx=payload.num_ctx))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Nao consegui gravar o .env: {exc}") from None


@app.post(
    "/api/setup/models/pull", response_model=SetupTask, status_code=202, tags=["sistema"]
)
def pull_ollama_model(payload: OllamaModelRequest) -> SetupTask:
    """Baixa um modelo, acompanhado pelo mesmo mecanismo das instalacoes."""
    running = setup_doctor.running_for(f"pull:{payload.model.strip()}")
    if running is not None:
        return SetupTask(**running.to_dict())

    try:
        return SetupTask(**setup_doctor.start_pull(payload.model).to_dict())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from None


@app.get("/api/setup/tasks/{task_id}", response_model=SetupTask, tags=["sistema"])
def setup_task(task_id: str) -> SetupTask:
    """Estado e log de uma instalacao em andamento."""
    task = setup_doctor.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Instalacao nao encontrada.")
    return SetupTask(**task.to_dict())


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


def _options_from_request(payload: JobCreateRequest) -> PipelineOptions:
    return PipelineOptions(
        min_clips=payload.min_clips,
        max_clips=payload.max_clips,
        language=payload.language,
        reframe_mode=payload.reframe_mode,
        burn_subtitles=payload.burn_subtitles,
        use_cache=payload.use_cache,
        dry_run=payload.dry_run,
    )


@app.post("/api/jobs", response_model=JobSummary, status_code=202, tags=["jobs"])
def create_job(payload: JobCreateRequest) -> JobSummary:
    """Enfileira o processamento de uma URL ou de um arquivo local."""
    source = payload.source.strip()
    if not source:
        raise HTTPException(status_code=400, detail="Campo 'source' vazio.")

    if not ingest.is_url(source) and not Path(source).expanduser().exists():
        raise HTTPException(status_code=404, detail=f"Arquivo nao encontrado: {source}")

    job = manager.submit(source, _options_from_request(payload))
    return JobSummary(**job.snapshot())


@app.post("/api/jobs/upload", response_model=JobSummary, status_code=202, tags=["jobs"])
async def create_job_from_upload(
    file: UploadFile = File(...),
    min_clips: int | None = None,
    max_clips: int | None = None,
    language: str | None = None,
) -> JobSummary:
    """Recebe um arquivo de video enviado pela UI e enfileira o processamento."""
    if not file.filename:
        raise HTTPException(status_code=400, detail="Arquivo sem nome.")

    suffix = Path(file.filename).suffix or ".mp4"
    with tempfile.NamedTemporaryFile(delete=False, suffix=suffix) as tmp:
        # Copia em blocos: uploads de live tem varios GB e nao cabem em memoria.
        await asyncio.to_thread(shutil.copyfileobj, file.file, tmp, 1024 * 1024)
        temp_path = tmp.name

    stored = ingest.stage_upload(temp_path, file.filename)
    logger.info("Upload recebido: %s", stored)

    job = manager.submit(
        str(stored),
        PipelineOptions(min_clips=min_clips, max_clips=max_clips, language=language),
    )
    return JobSummary(**job.snapshot())


@app.get("/api/jobs", response_model=list[JobSummary], tags=["jobs"])
def list_jobs() -> list[JobSummary]:
    """Lista os jobs desta sessao do servidor, do mais recente ao mais antigo."""
    return [JobSummary(**job.snapshot()) for job in manager.list()]


@app.get("/api/jobs/{job_id}", response_model=JobSummary, tags=["jobs"])
def get_job(job_id: str) -> JobSummary:
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nao encontrado.")
    return JobSummary(**job.snapshot())


@app.delete("/api/jobs/{job_id}", tags=["jobs"])
def cancel_job(job_id: str) -> dict[str, Any]:
    """Cancela um job na fila ou pede parada ao final da etapa atual."""
    if not manager.cancel(job_id):
        raise HTTPException(status_code=409, detail="Job nao pode mais ser cancelado.")
    return {"cancelled": job_id}


# ---------------------------------------------------------------------------
# WebSocket de progresso
# ---------------------------------------------------------------------------


@app.websocket("/ws/jobs/{job_id}")
async def job_events(websocket: WebSocket, job_id: str) -> None:
    """Transmite o progresso de um job em tempo real.

    Ao conectar, o cliente recebe o snapshot atual e o historico de eventos —
    assim a UI reconstroi a tela mesmo entrando no meio do processamento.
    """
    await websocket.accept()

    job = manager.get(job_id)
    if job is None:
        await websocket.send_json({"type": "error", "message": "Job nao encontrado."})
        await websocket.close()
        return

    queue = manager.subscribe(job_id)
    try:
        await websocket.send_json({"type": "snapshot", **job.snapshot()})
        for event in list(job.events):
            await websocket.send_json({"type": "progress", "job_id": job_id, **event})

        # O job pode ter terminado antes de este cliente conectar (recarregar a
        # pagina, por exemplo). Sem este `done`, o cliente ficaria esperando um
        # evento que ja passou.
        if job.status in _TERMINAL_STATUSES:
            await websocket.send_json({"type": "done", **job.snapshot()})
            return

        while True:
            payload = await queue.get()
            await websocket.send_json(payload)

            if payload.get("type") == "done":
                break
    except WebSocketDisconnect:
        logger.debug("Cliente desconectou do job %s", job_id)
    except Exception as exc:
        logger.warning("WebSocket do job %s encerrado: %s", job_id, exc)
    finally:
        manager.unsubscribe(job_id, queue)


# ---------------------------------------------------------------------------
# Projetos
# ---------------------------------------------------------------------------


def _require_project(project_id: str) -> projects.Project:
    """Carrega um projeto ou devolve 404."""
    project = projects.load(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    return project


def _require_source(project: projects.Project) -> str:
    """Caminho do video de origem, ou 409 se ele nao estiver mais no disco."""
    if not project.has_source:
        raise HTTPException(
            status_code=409,
            detail="O video de origem deste projeto nao esta mais disponivel.",
        )
    return project.media["path"]  # type: ignore[index]


@app.get("/api/projects", response_model=list[ProjectSummary], tags=["projetos"])
def list_projects() -> list[ProjectSummary]:
    """Todos os projetos, do mais recente ao mais antigo."""
    return [ProjectSummary(**project.summary()) for project in projects.list_all()]


@app.get("/api/projects/{project_id}", response_model=ProjectDetail, tags=["projetos"])
def get_project(project_id: str) -> ProjectDetail:
    """Projeto completo: trechos analisados e cortes gerados."""
    return ProjectDetail(**_require_project(project_id).to_dict())


@app.patch("/api/projects/{project_id}", response_model=ProjectDetail, tags=["projetos"])
def rename_project(project_id: str, payload: ProjectRenameRequest) -> ProjectDetail:
    """Renomeia o projeto."""
    _require_project(project_id)
    updated = projects.update(project_id, title=payload.title.strip())
    if updated is None:
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    return ProjectDetail(**updated.to_dict())


@app.delete("/api/projects/{project_id}", tags=["projetos"])
def delete_project(project_id: str, keep_files: bool = False) -> dict[str, Any]:
    """Apaga o projeto. Por padrao remove tambem os cortes gerados."""
    if not projects.delete(project_id, remove_files=not keep_files):
        raise HTTPException(status_code=404, detail="Projeto nao encontrado.")
    return {"deleted": project_id, "files_removed": not keep_files}


@app.delete("/api/projects/{project_id}/clips/{clip_id}", tags=["projetos"])
def delete_clip(project_id: str, clip_id: str) -> dict[str, Any]:
    """Remove um corte do projeto e do disco."""
    if not projects.remove_clip(project_id, clip_id):
        raise HTTPException(status_code=404, detail="Corte nao encontrado.")
    return {"deleted": clip_id}


# ---------------------------------------------------------------------------
# Edicao de cortes: previa e renderizacao sob medida
# ---------------------------------------------------------------------------


@app.get("/api/projects/{project_id}/source", tags=["edicao"])
def project_source(project_id: str) -> FileResponse:
    """Serve o video de origem do projeto, para a previa no editor.

    O `FileResponse` do Starlette responde a `Range`, entao o player pula
    direto para o trecho do corte sem baixar o arquivo inteiro — o que importa
    quando a live tem 15 GB.
    """
    project = _require_project(project_id)
    path = Path(_require_source(project))
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get(
    "/api/projects/{project_id}/words", response_model=WordsResponse, tags=["edicao"]
)
def project_words(project_id: str, start: float, end: float) -> WordsResponse:
    """Palavras faladas no trecho, com timestamps.

    A previa da interface usa isto para desenhar a legenda animada em tempo
    real, com o mesmo agrupamento que o arquivo `.ass` tera no final.
    """
    project = _require_project(project_id)
    if not project.transcript_path:
        return WordsResponse(words=[])

    transcript = transcriber.load_transcript(project.transcript_path)
    if transcript is None:
        return WordsResponse(words=[])

    return WordsResponse(words=[w.to_dict() for w in transcript.words_between(start, end)])


@app.get(
    "/api/projects/{project_id}/suggest",
    response_model=SuggestionResponse,
    tags=["edicao"],
)
def suggest_layout(project_id: str, start: float, end: float) -> SuggestionResponse:
    """Recomenda layout e formato para um trecho, antes de o usuario decidir.

    Detecta rostos em alguns segundos do meio do corte. Um rosto pequeno e
    encostado numa borda quase sempre e webcam sobre captura de tela — nesse
    caso a resposta ja vem com as duas faixas prontas para o layout empilhado.
    """
    project = _require_project(project_id)
    source = _require_source(project)
    if end <= start:
        raise HTTPException(status_code=400, detail="Intervalo invalido.")

    try:
        suggestion = reframer.suggest_layout(source, start, end)
    except Exception as exc:
        logger.exception("Sugestao de layout falhou")
        raise HTTPException(status_code=500, detail=f"Falha ao analisar: {exc}") from exc

    return SuggestionResponse(**suggestion.to_dict())


@app.post(
    "/api/projects/{project_id}/render", response_model=RenderResponse, tags=["edicao"]
)
def render_clip(project_id: str, payload: RenderRequest) -> RenderResponse:
    """Renderiza o corte no projeto, um arquivo por formato pedido.

    Reaproveita o video e a transcricao que o projeto ja tem: so o encode do
    trecho e refeito, o que leva segundos em vez de repetir a pipeline inteira.
    O plano de enquadramento e recalculado por formato — a proporcao muda a
    janela de crop, entao nao da para reaproveitar entre formatos diferentes.
    """
    project = _require_project(project_id)
    media_path = _require_source(project)

    if payload.end_time <= payload.start_time:
        raise HTTPException(status_code=400, detail="O fim do corte precisa vir depois do inicio.")
    if payload.reframe_mode == "composite" and not payload.regions:
        raise HTTPException(status_code=400, detail="O layout composto exige ao menos uma faixa.")

    regions = (
        [
            LayoutRegion(
                x=r.x, y=r.y, width=r.width, height=r.height, weight=r.weight, label=r.label
            )
            for r in payload.regions
        ]
        if payload.regions
        else None
    )

    # Legenda e transcricao sao as mesmas para todos os formatos.
    words: list = []
    transcript_text = ""
    if payload.burn_subtitles and project.transcript_path:
        transcript = transcriber.load_transcript(project.transcript_path)
        if transcript is not None:
            words = transcript.words_between(payload.start_time, payload.end_time)
            transcript_text = transcript.text_between(payload.start_time, payload.end_time)

    style: dict[str, Any] | None = None
    if payload.subtitle_style is not None:
        s = payload.subtitle_style
        style = {
            "font_size": s.font_size,
            "margin_v": s.margin_v,
            "max_words": s.max_words,
            "primary_color": subtitles.hex_to_ass(s.primary_color, settings.subtitle_primary_color),
            "highlight_color": subtitles.hex_to_ass(
                s.highlight_color, settings.subtitle_highlight_color
            ),
        }

    rendered: list[dict[str, Any]] = []

    for value in payload.aspect_ratios:
        aspect = AspectRatio(value)
        title = payload.title or f"Corte {payload.start_time:.0f}s"
        candidate = ClipCandidate(
            id=uuid.uuid4().hex[:8],
            start_time=payload.start_time,
            end_time=payload.end_time,
            title=title,
            virality_score=0.0,
            final_score=0.0,
            transcript_text=transcript_text,
        )

        logger.info(
            "Render no projeto %s: %.1f-%.1fs, %s, modo=%s",
            project_id,
            payload.start_time,
            payload.end_time,
            value,
            payload.reframe_mode,
        )

        try:
            plan = reframer.build_plan(
                media_path,
                payload.start_time,
                payload.end_time,
                mode=payload.reframe_mode,
                aspect_ratio=aspect.ratio,
                manual_offset=payload.manual_offset,
                regions=regions,
            )
            clip = renderer.render_clip(
                media_path,
                candidate,
                plan,
                words=words,
                burn_subtitles=payload.burn_subtitles,
                output_size=aspect.size(),
                subtitle_style=style,
                # Cada corte nasce dentro da pasta do seu projeto.
                output_path=projects.clip_output_path(project, title, candidate.id),
            )
        except Exception as exc:
            logger.exception("Render falhou (%s)", value)
            raise HTTPException(
                status_code=500, detail=f"Falha ao renderizar {value}: {exc}"
            ) from exc

        entry = {
            **clip.to_dict(),
            "aspect_ratio": value,
            "media_url": projects.media_url(project_id, clip.video_path),
            "thumbnail_url": (
                projects.media_url(project_id, clip.thumbnail_path)
                if clip.thumbnail_path
                else None
            ),
        }
        projects.add_clip(project_id, entry)
        rendered.append(entry)

    return RenderResponse(clips=rendered)


@app.get("/api/formats", tags=["edicao"])
def list_formats() -> dict[str, Any]:
    """Formatos de saida disponiveis, para a UI montar o seletor."""
    return {
        "formats": [
            {
                "value": ratio.value,
                "width": ratio.size()[0],
                "height": ratio.size()[1],
                "label": _FORMAT_LABELS[ratio],
            }
            for ratio in AspectRatio
        ],
        "reframe_modes": [
            {"value": "auto", "label": "Automatico"},
            {"value": "single", "label": "Seguir o falante"},
            {"value": "split", "label": "Split-screen"},
            {"value": "center", "label": "Centro fixo"},
            {"value": "manual", "label": "Posicao manual"},
            {"value": "composite", "label": "Gameplay + webcam"},
        ],
    }


_FORMAT_LABELS = {
    AspectRatio.VERTICAL: "9:16 — TikTok, Reels, Shorts",
    AspectRatio.PORTRAIT: "4:5 — feed do Instagram",
    AspectRatio.SQUARE: "1:1 — quadrado",
    AspectRatio.LANDSCAPE: "16:9 — YouTube",
}


# ---------------------------------------------------------------------------
# Biblioteca de cortes
# ---------------------------------------------------------------------------


@app.get("/api/clips", response_model=ClipListResponse, tags=["clips"])
def list_all_clips() -> ClipListResponse:
    """Todos os cortes de todos os projetos, do mais recente ao mais antigo.

    Serve a visao "biblioteca" da interface; para navegar por video, use
    `/api/projects`.
    """
    clips: list[dict[str, Any]] = []

    for project in projects.list_all():
        for clip in project.clips:
            if not Path(clip.get("video_path", "")).is_file():
                continue
            clips.append(
                {
                    **clip,
                    "project_id": project.id,
                    "project_title": project.title,
                }
            )

    return ClipListResponse(clips=clips)


@app.get("/api/projects/{project_id}/clips/{filename}/download", tags=["clips"])
def download_clip(project_id: str, filename: str) -> FileResponse:
    """Baixa um corte de um projeto."""
    project = _require_project(project_id)

    # Normaliza o nome para impedir escapar da pasta do projeto.
    path = (project.clips_dir / Path(filename).name).resolve()
    if not path.is_file() or project.clips_dir.resolve() not in path.parents:
        raise HTTPException(status_code=404, detail="Corte nao encontrado.")
    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/", tags=["sistema"])
def root() -> dict[str, str]:
    return {
        "name": "ClipForge",
        "version": __version__,
        "docs": "/docs",
        "health": "/api/health",
    }
