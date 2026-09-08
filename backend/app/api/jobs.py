"""Fila de jobs em memoria com difusao de eventos por WebSocket.

Por que nao Celery/RQ: processar video e um gargalo de GPU, nao de I/O. Numa
maquina so, rodar mais de um job simultaneo apenas divide a mesma VRAM e deixa
tudo mais lento. Uma fila em memoria com um pool de N threads (padrao: 1)
resolve o caso real sem exigir Redis nem um segundo processo.

Cada job guarda seu historico de eventos, entao um cliente que conecta no meio
do processamento recebe o estado atual antes de comecar a receber ao vivo.
"""

from __future__ import annotations

import asyncio
import threading
import time
import uuid
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

from app.config import settings
from app.core.pipeline import PipelineOptions, run as run_pipeline
from app.utils.logging import get_logger

logger = get_logger(__name__)

# Quantos eventos de progresso ficam guardados por job (o suficiente para um
# cliente novo reconstruir o estado sem estourar a memoria em jobs longos).
_MAX_EVENTS = 400


class JobStatus(str, Enum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass
class Job:
    """Uma execucao da pipeline, do enfileiramento ao resultado."""

    id: str
    source: str
    options: PipelineOptions
    status: JobStatus = JobStatus.QUEUED
    progress: float = 0.0
    stage: str = "queued"
    message: str = "Na fila..."
    created_at: float = field(default_factory=time.time)
    started_at: float | None = None
    finished_at: float | None = None
    error: str | None = None
    result: dict[str, Any] | None = None
    clips: list[dict[str, Any]] = field(default_factory=list)
    candidates: list[dict[str, Any]] = field(default_factory=list)
    events: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=_MAX_EVENTS))
    cancel_requested: bool = False

    def snapshot(self) -> dict[str, Any]:
        """Estado atual do job, serializavel em JSON."""
        return {
            "id": self.id,
            "source": self.source,
            "status": self.status.value,
            "progress": round(self.progress, 4),
            "stage": self.stage,
            "message": self.message,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "error": self.error,
            "clips": self.clips,
            "candidates": self.candidates,
            "result": self.result,
        }


class JobManager:
    """Registro de jobs + pool de execucao + broadcast assincrono.

    A pipeline roda em threads; os WebSockets vivem no loop asyncio. A ponte
    entre os dois e `asyncio.run_coroutine_threadsafe`, por isso o loop precisa
    ser registrado no startup da aplicacao (`bind_loop`).
    """

    def __init__(self, max_workers: int | None = None) -> None:
        self._jobs: dict[str, Job] = {}
        self._lock = threading.Lock()
        self._executor = ThreadPoolExecutor(
            max_workers=max_workers or settings.max_concurrent_jobs,
            thread_name_prefix="clipforge-job",
        )
        self._subscribers: dict[str, set[asyncio.Queue]] = {}
        self._loop: asyncio.AbstractEventLoop | None = None

    # ------------------------------------------------------------ ciclo de vida

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Registra o event loop usado para entregar eventos aos WebSockets."""
        self._loop = loop

    def shutdown(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ------------------------------------------------------------------ jobs

    def submit(self, source: str, options: PipelineOptions | None = None) -> Job:
        """Cria um job e o enfileira para execucao."""
        job = Job(id=uuid.uuid4().hex[:12], source=source, options=options or PipelineOptions())

        with self._lock:
            self._jobs[job.id] = job

        self._executor.submit(self._run, job)
        logger.info("Job %s enfileirado: %s", job.id, source)
        return job

    def get(self, job_id: str) -> Job | None:
        with self._lock:
            return self._jobs.get(job_id)

    def list(self) -> list[Job]:
        with self._lock:
            return sorted(self._jobs.values(), key=lambda j: j.created_at, reverse=True)

    def cancel(self, job_id: str) -> bool:
        """Pede o cancelamento de um job.

        Jobs ainda na fila sao cancelados na hora. Um job em execucao para na
        proxima fronteira de etapa — nao ha como interromper um encode do FFmpeg
        no meio sem deixar arquivo corrompido.
        """
        job = self.get(job_id)
        if job is None or job.status in (JobStatus.COMPLETED, JobStatus.FAILED):
            return False

        job.cancel_requested = True
        if job.status is JobStatus.QUEUED:
            job.status = JobStatus.CANCELLED
            job.message = "Cancelado antes de iniciar."
            job.finished_at = time.time()
            self._publish(job, job.snapshot())
        else:
            job.message = "Cancelamento solicitado; encerrando apos a etapa atual."
            self._publish(job, job.snapshot())
        return True

    # -------------------------------------------------------------- execucao

    def _run(self, job: Job) -> None:
        if job.cancel_requested:
            return

        job.status = JobStatus.RUNNING
        job.started_at = time.time()
        self._publish(job, job.snapshot())

        def on_event(event: dict[str, Any]) -> None:
            if job.cancel_requested:
                raise JobCancelled(job.id)

            job.progress = event.get("progress", job.progress)
            job.stage = event.get("stage", job.stage)
            job.message = event.get("message", job.message)
            job.events.append(event)

            if "clip" in event:
                job.clips.append(event["clip"])
            if "candidates" in event:
                job.candidates = event["candidates"]
            if "result" in event:
                job.result = event["result"]

            self._publish(job, {"type": "progress", **event, "job_id": job.id})

        try:
            result = run_pipeline(job.source, options=job.options, on_event=on_event)
            job.status = JobStatus.COMPLETED
            job.progress = 1.0
            job.result = result.to_dict()
            job.clips = [c.to_dict() for c in result.clips]
            job.message = f"{len(result.clips)} cortes gerados."
        except JobCancelled:
            job.status = JobStatus.CANCELLED
            job.message = "Job cancelado."
            logger.info("Job %s cancelado.", job.id)
        except Exception as exc:
            job.status = JobStatus.FAILED
            job.error = str(exc)
            job.message = f"Erro: {exc}"
            logger.exception("Job %s falhou", job.id)
        finally:
            job.finished_at = time.time()
            self._publish(job, {"type": "done", **job.snapshot()})

    # ------------------------------------------------------------- broadcast

    def subscribe(self, job_id: str) -> asyncio.Queue:
        """Registra um assinante de eventos de um job."""
        queue: asyncio.Queue = asyncio.Queue(maxsize=200)
        self._subscribers.setdefault(job_id, set()).add(queue)
        return queue

    def unsubscribe(self, job_id: str, queue: asyncio.Queue) -> None:
        subscribers = self._subscribers.get(job_id)
        if subscribers:
            subscribers.discard(queue)
            if not subscribers:
                self._subscribers.pop(job_id, None)

    def _publish(self, job: Job, payload: dict[str, Any]) -> None:
        """Entrega um evento a todos os assinantes (thread -> event loop)."""
        subscribers = self._subscribers.get(job.id)
        if not subscribers or self._loop is None:
            return

        for queue in list(subscribers):
            try:
                self._loop.call_soon_threadsafe(queue.put_nowait, payload)
            except (RuntimeError, asyncio.QueueFull):
                # Cliente lento ou loop encerrando: descarta o evento em vez de
                # travar a thread da pipeline.
                pass


class JobCancelled(RuntimeError):
    """Levantada de dentro da pipeline quando o usuario cancela o job."""


# Instancia unica usada pela aplicacao FastAPI.
manager = JobManager()
