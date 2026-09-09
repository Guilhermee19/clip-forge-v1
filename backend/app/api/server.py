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
    RenderRequest,
    RenderResponse,
    SuggestionResponse,
)
from app.config import settings
from app.core import analyzer, ingest, reframer, renderer, transcriber
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

# Serve os videos renderizados para o player da UI.
app.mount("/media", StaticFiles(directory=str(settings.clips_dir)), name="media")


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
# Edicao de cortes: previa e renderizacao sob medida
# ---------------------------------------------------------------------------


@app.get("/api/jobs/{job_id}/source", tags=["edicao"])
def job_source(job_id: str) -> FileResponse:
    """Serve o video de origem do job, para a previa no editor.

    O `FileResponse` do Starlette responde a `Range`, entao o player consegue
    pular direto para o trecho do corte sem baixar o arquivo inteiro — o que
    importa quando a live tem 15 GB.
    """
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nao encontrado.")
    if not job.media or not job.media.get("path"):
        raise HTTPException(status_code=409, detail="A midia deste job ainda nao foi preparada.")

    path = Path(job.media["path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo de origem nao esta mais no disco.")

    return FileResponse(path, media_type="video/mp4", filename=path.name)


@app.get("/api/jobs/{job_id}/suggest", response_model=SuggestionResponse, tags=["edicao"])
def suggest_layout(job_id: str, start: float, end: float) -> SuggestionResponse:
    """Recomenda layout e formato para um trecho, antes de o usuario decidir.

    Detecta rostos em alguns segundos do meio do corte. Um rosto pequeno e
    encostado numa borda quase sempre e webcam sobre captura de tela — nesse
    caso a resposta ja vem com as duas faixas prontas para o layout empilhado.
    """
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nao encontrado.")
    if not job.media or not Path(job.media.get("path", "")).is_file():
        raise HTTPException(status_code=409, detail="A midia deste job nao esta disponivel.")
    if end <= start:
        raise HTTPException(status_code=400, detail="Intervalo invalido.")

    try:
        suggestion = reframer.suggest_layout(job.media["path"], start, end)
    except Exception as exc:
        logger.exception("Sugestao de layout falhou")
        raise HTTPException(status_code=500, detail=f"Falha ao analisar: {exc}") from exc

    return SuggestionResponse(**suggestion.to_dict())


@app.post("/api/jobs/{job_id}/render", response_model=RenderResponse, tags=["edicao"])
def render_edited_clip(job_id: str, payload: RenderRequest) -> RenderResponse:
    """Renderiza o corte, um arquivo por formato pedido.

    Reaproveita o video e a transcricao que o job ja produziu: so o encode do
    trecho e refeito, o que leva segundos em vez de repetir a pipeline inteira.
    O plano de enquadramento e calculado uma vez por formato — a proporcao muda
    a janela de crop, entao nao da para reaproveitar entre formatos diferentes.
    """
    job = manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job nao encontrado.")
    if not job.media or not Path(job.media.get("path", "")).is_file():
        raise HTTPException(status_code=409, detail="A midia deste job nao esta disponivel.")
    if payload.end_time <= payload.start_time:
        raise HTTPException(status_code=400, detail="O fim do corte precisa vir depois do inicio.")
    if payload.reframe_mode == "composite" and not payload.regions:
        raise HTTPException(
            status_code=400, detail="O layout composto exige ao menos uma faixa."
        )

    media_path = job.media["path"]

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

    # Legenda e transcricao sao os mesmos para todos os formatos.
    words: list = []
    transcript_text = ""
    if payload.burn_subtitles and job.transcript_path:
        transcript = transcriber.load_transcript(job.transcript_path)
        if transcript is not None:
            words = transcript.words_between(payload.start_time, payload.end_time)
            transcript_text = transcript.text_between(payload.start_time, payload.end_time)

    rendered: list[dict[str, Any]] = []

    for value in payload.aspect_ratios:
        aspect = AspectRatio(value)
        candidate = ClipCandidate(
            id=uuid.uuid4().hex[:8],
            start_time=payload.start_time,
            end_time=payload.end_time,
            title=payload.title or f"Corte {payload.start_time:.0f}s",
            virality_score=0.0,
            final_score=0.0,
            transcript_text=transcript_text,
        )

        logger.info(
            "Render do job %s: %.1f-%.1fs, %s, modo=%s",
            job_id,
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
            )
        except Exception as exc:
            logger.exception("Render sob medida falhou (%s)", value)
            raise HTTPException(
                status_code=500, detail=f"Falha ao renderizar {value}: {exc}"
            ) from exc

        thumbnail = Path(clip.thumbnail_path).name if clip.thumbnail_path else None
        rendered.append(
            {
                **clip.to_dict(),
                "aspect_ratio": value,
                "media_url": f"/media/{Path(clip.video_path).name}",
                "thumbnail_url": f"/media/{thumbnail}" if thumbnail else None,
            }
        )

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
def list_clips() -> ClipListResponse:
    """Lista os cortes ja renderizados, lidos do manifesto em disco."""
    manifest = settings.clips_dir / "manifest.json"
    if not manifest.exists():
        return ClipListResponse(clips=[])

    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ClipListResponse(clips=[])

    clips: list[dict[str, Any]] = []
    for entry in reversed(entries):
        for clip in entry.get("clips", []):
            video = Path(clip.get("video_path", ""))
            if not video.exists():
                continue
            clips.append(
                {
                    **clip,
                    "source_title": entry.get("title"),
                    "created_at": entry.get("created_at"),
                    "media_url": f"/media/{video.name}",
                    "thumbnail_url": (
                        f"/media/{Path(clip['thumbnail_path']).name}"
                        if clip.get("thumbnail_path")
                        else None
                    ),
                }
            )
    return ClipListResponse(clips=clips)


@app.get("/api/clips/{filename}/download", tags=["clips"])
def download_clip(filename: str) -> FileResponse:
    """Baixa um corte renderizado."""
    # Normaliza o nome para impedir escapar do diretorio de saida.
    path = (settings.clips_dir / Path(filename).name).resolve()
    if not path.is_file() or settings.clips_dir.resolve() not in path.parents:
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
