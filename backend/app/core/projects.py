"""Projetos: um por video de origem, persistidos em disco.

Antes, tudo vivia na memoria do servidor: reiniciar a API perdia a lista de
trechos analisados, e todos os cortes caiam juntos em `output/clips/`. Com dez
videos processados ficava impossivel saber qual arquivo era de qual live.

Um projeto agrupa tudo que pertence a um video de origem:

    output/projects/<id>/
        project.json      metadados, trechos analisados e cortes gerados
        clips/            os videos renderizados deste projeto

O `id` e derivado da fonte (URL ou caminho), entao reprocessar o mesmo link cai
no mesmo projeto e reaproveita download e transcricao em vez de duplicar.
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

# Serializa a escrita: dois jobs terminando juntos poderiam sobrescrever um ao
# outro ao salvar o mesmo `project.json`.
_lock = threading.RLock()


@dataclass
class Project:
    """Um video de origem e tudo que foi produzido a partir dele."""

    id: str
    source: str
    title: str
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    # "new" | "analyzing" | "ready" | "failed"
    status: str = "new"
    source_url: str | None = None
    media: dict[str, Any] | None = None
    transcript_path: str | None = None
    candidates: list[dict[str, Any]] = field(default_factory=list)
    clips: list[dict[str, Any]] = field(default_factory=list)
    last_error: str | None = None

    # ------------------------------------------------------------- caminhos

    @property
    def directory(self) -> Path:
        return projects_dir() / self.id

    @property
    def clips_dir(self) -> Path:
        return self.directory / "clips"

    @property
    def manifest_path(self) -> Path:
        return self.directory / "project.json"

    # -------------------------------------------------------------- derivados

    @property
    def has_source(self) -> bool:
        """True se o video de origem ainda esta no disco (previa e reedicao)."""
        return bool(self.media and Path(self.media.get("path", "")).is_file())

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["has_source"] = self.has_source
        data["clip_count"] = len(self.clips)
        data["candidate_count"] = len(self.candidates)
        return data

    def summary(self) -> dict[str, Any]:
        """Versao leve para a listagem: sem transcricao nem lista de trechos."""
        thumbnail = self.clips[0].get("thumbnail_path") if self.clips else None
        return {
            "id": self.id,
            "title": self.title,
            "source": self.source,
            "source_url": self.source_url,
            "status": self.status,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "clip_count": len(self.clips),
            "candidate_count": len(self.candidates),
            "has_source": self.has_source,
            "duration": (self.media or {}).get("duration", 0.0),
            "thumbnail_url": media_url(self.id, thumbnail) if thumbnail else None,
            "last_error": self.last_error,
        }


# ---------------------------------------------------------------------------
# Localizacao e identidade
# ---------------------------------------------------------------------------


def media_url(project_id: str, file_path: str | Path) -> str:
    """URL publica de um arquivo dentro da pasta de cortes de um projeto.

    A montagem `/media` do FastAPI aponta para `output/projects`, entao o
    caminho servido espelha a estrutura em disco.
    """
    return f"/media/{project_id}/clips/{Path(file_path).name}"


def projects_dir() -> Path:
    """Diretorio raiz dos projetos, criado sob demanda."""
    path = settings.output_dir / "projects"
    path.mkdir(parents=True, exist_ok=True)
    return path


def project_id_for(source: str) -> str:
    """Identificador estavel para uma fonte.

    A mesma URL sempre gera o mesmo id, entao reprocessar um link reabre o
    projeto existente em vez de criar um duplicado.
    """
    return hashlib.sha1(source.strip().encode("utf-8")).hexdigest()[:12]


def _slugify(text: str, max_length: int = 60) -> str:
    slug = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    slug = re.sub(r"[\s_-]+", "-", slug)
    return slug[:max_length].strip("-") or "projeto"


# ---------------------------------------------------------------------------
# Persistencia
# ---------------------------------------------------------------------------


def save(project: Project) -> Project:
    """Grava o `project.json`, de forma atomica."""
    with _lock:
        project.updated_at = time.time()
        project.directory.mkdir(parents=True, exist_ok=True)
        project.clips_dir.mkdir(parents=True, exist_ok=True)

        # Escreve num temporario e troca: uma queda no meio da escrita nao
        # deixa um JSON pela metade, que faria o projeto sumir da listagem.
        temp = project.manifest_path.with_suffix(".json.tmp")
        temp.write_text(
            json.dumps(asdict(project), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temp.replace(project.manifest_path)
    return project


def load(project_id: str) -> Project | None:
    """Le um projeto do disco; `None` se nao existir ou estiver corrompido."""
    manifest = projects_dir() / project_id / "project.json"
    if not manifest.is_file():
        return None
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return Project(**data)
    except (json.JSONDecodeError, TypeError) as exc:
        logger.warning("Projeto %s ilegivel: %s", project_id, exc)
        return None


def get_or_create(source: str, *, title: str | None = None) -> Project:
    """Projeto da fonte informada, criando-o se ainda nao existir."""
    project_id = project_id_for(source)

    with _lock:
        existing = load(project_id)
        if existing is not None:
            return existing

        project = Project(
            id=project_id,
            source=source,
            title=title or _default_title(source),
            source_url=source if source.startswith("http") else None,
        )
        logger.info("Projeto criado: %s (%s)", project.id, project.title)
        return save(project)


def _default_title(source: str) -> str:
    """Titulo provisorio ate a ingestao trazer o nome real do video."""
    if source.startswith("http"):
        return source.split("/")[-1][:60] or "Video da web"
    return Path(source).stem[:60] or "Video local"


def list_all() -> list[Project]:
    """Todos os projetos, do mais recente ao mais antigo."""
    projects = [
        project
        for entry in projects_dir().iterdir()
        if entry.is_dir() and (project := load(entry.name)) is not None
    ]
    return sorted(projects, key=lambda p: p.updated_at, reverse=True)


def delete(project_id: str, *, remove_files: bool = True) -> bool:
    """Remove um projeto. Com `remove_files`, apaga tambem os cortes gerados."""
    with _lock:
        directory = projects_dir() / project_id
        if not directory.is_dir():
            return False
        if remove_files:
            shutil.rmtree(directory, ignore_errors=True)
        else:
            (directory / "project.json").unlink(missing_ok=True)
        logger.info("Projeto %s removido (arquivos: %s)", project_id, remove_files)
        return True


# ---------------------------------------------------------------------------
# Atualizacoes pontuais
# ---------------------------------------------------------------------------


def update(project_id: str, **fields: Any) -> Project | None:
    """Aplica campos a um projeto e salva. Ignora chaves desconhecidas."""
    with _lock:
        project = load(project_id)
        if project is None:
            return None
        for key, value in fields.items():
            if hasattr(project, key):
                setattr(project, key, value)
        return save(project)


def add_clip(project_id: str, clip: dict[str, Any]) -> Project | None:
    """Anexa um corte renderizado ao projeto, sem duplicar pelo id."""
    with _lock:
        project = load(project_id)
        if project is None:
            return None
        project.clips = [c for c in project.clips if c.get("id") != clip.get("id")]
        project.clips.insert(0, clip)
        return save(project)


def remove_clip(project_id: str, clip_id: str, *, remove_file: bool = True) -> bool:
    """Remove um corte do projeto e, opcionalmente, do disco."""
    with _lock:
        project = load(project_id)
        if project is None:
            return False

        target = next((c for c in project.clips if c.get("id") == clip_id), None)
        if target is None:
            return False

        if remove_file:
            for key in ("video_path", "subtitle_path", "thumbnail_path"):
                path = target.get(key)
                if path:
                    Path(path).unlink(missing_ok=True)

        project.clips = [c for c in project.clips if c.get("id") != clip_id]
        save(project)
        return True


def clip_output_path(project: Project, title: str, clip_id: str) -> Path:
    """Caminho do arquivo de um corte, dentro da pasta do projeto."""
    project.clips_dir.mkdir(parents=True, exist_ok=True)
    return project.clips_dir / f"{_slugify(title, 48)}-{clip_id}.mp4"


# ---------------------------------------------------------------------------
# Migracao do formato antigo
# ---------------------------------------------------------------------------


def migrate_legacy() -> int:
    """Converte o `output/clips/manifest.json` antigo em projetos.

    Antes dos projetos, todos os cortes iam para uma pasta so, indexados por um
    manifesto plano. Esta funcao agrupa aquelas entradas por video de origem,
    cria um projeto para cada e move os arquivos para dentro dele. Roda uma vez
    e marca o manifesto como processado.

    Returns:
        Quantos projetos foram criados.
    """
    manifest = settings.clips_dir / "manifest.json"
    if not manifest.is_file():
        return 0

    try:
        entries = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        logger.warning("manifest.json antigo ilegivel; ignorando a migracao.")
        manifest.rename(manifest.with_suffix(".json.invalid"))
        return 0

    created = 0
    for entry in entries:
        source = entry.get("source")
        if not source:
            continue

        project = get_or_create(source, title=entry.get("title"))
        moved: list[dict[str, Any]] = []

        for clip in entry.get("clips", []):
            video = Path(clip.get("video_path", ""))
            if not video.is_file():
                continue

            # Move video, legenda e capa para a pasta do projeto.
            for key in ("video_path", "subtitle_path", "thumbnail_path"):
                origin = clip.get(key)
                if not origin or not Path(origin).is_file():
                    continue
                destination = project.clips_dir / Path(origin).name
                destination.parent.mkdir(parents=True, exist_ok=True)
                try:
                    shutil.move(str(origin), destination)
                except (OSError, shutil.Error) as exc:
                    logger.warning("Nao consegui mover %s: %s", origin, exc)
                    continue
                clip[key] = str(destination)

            clip["media_url"] = media_url(project.id, clip["video_path"])
            if clip.get("thumbnail_path"):
                clip["thumbnail_url"] = media_url(project.id, clip["thumbnail_path"])
            moved.append(clip)

        if moved:
            project.clips = moved + project.clips
            project.status = "ready"
            save(project)
            created += 1

    manifest.rename(manifest.with_suffix(".json.migrated"))
    logger.info("Migracao concluida: %d projeto(s) a partir do manifesto antigo.", created)
    return created
