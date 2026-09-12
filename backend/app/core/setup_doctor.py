"""Diagnostico com conserto: o que falta no ambiente e como instalar.

O `doctor` do CLI ja dizia *o que* estava quebrado, mas a resposta vinha em
prosa e cada pessoa ia caçar o comando certo na internet. Aqui cada requisito
carrega tres coisas juntas:

    1. uma sonda   -> esta instalado?
    2. um tutorial -> os passos manuais, para quem prefere fazer na mao
    3. um plano    -> a sequencia de comandos que a interface roda sozinha

Os comandos sao **fixos neste arquivo**. A API recebe apenas o id do requisito
e o valida contra este catalogo, entao nada que venha do navegador vira
argumento de subprocess.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger(__name__)

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"


# ---------------------------------------------------------------------------
# Catalogo
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Step:
    """Um comando do plano automatico."""

    label: str
    command: list[str]
    # Falhar aqui nao aborta o plano.
    optional: bool = False
    # Servico que nao termina sozinho: sobe destacado e o plano segue sem
    # esperar o processo morrer.
    background: bool = False


@dataclass(frozen=True)
class Requirement:
    """Um item do ambiente, com sonda, tutorial e plano de instalacao."""

    id: str
    label: str
    summary: str
    # Por que o ClipForge precisa disso, em uma frase.
    why: str
    tutorial: list[str]
    docs_url: str
    steps: list[Step] = field(default_factory=list)
    # Requisito que precisa estar OK antes deste fazer sentido.
    depends_on: str | None = None
    # True quando o processo do backend so enxerga a mudanca apos reiniciar.
    needs_restart: bool = False
    # Segundos para reconferir a sonda depois do plano, para servicos que
    # levam alguns instantes para responder.
    wait_seconds: float = 0.0


def _probe_ffmpeg() -> tuple[bool, str]:
    from app.utils import ffmpeg

    if not ffmpeg.ffmpeg_available():
        return False, "ffmpeg nao encontrado no PATH"
    return True, shutil.which(settings.ffmpeg_bin) or settings.ffmpeg_bin


def _probe_nvenc() -> tuple[bool, str]:
    from app.utils import ffmpeg

    if not ffmpeg.ffmpeg_available():
        return False, "sem ffmpeg, nao da para checar os encoders"
    if ffmpeg.has_nvenc():
        return True, "h264_nvenc compilado neste ffmpeg"
    return False, "este build do ffmpeg nao tem h264_nvenc; o encode cai na CPU"


def _probe_whisper_cuda() -> tuple[bool, str]:
    from app.utils.cuda import resolve_device

    device = resolve_device(settings.whisper_device)
    if device == "cuda":
        return True, "CTranslate2 enxerga a GPU"
    if settings.whisper_device == "cpu":
        return False, "WHISPER_DEVICE=cpu no .env; a transcricao roda na CPU de proposito"
    return False, "cuBLAS/cuDNN nao encontrados: a transcricao vai rodar na CPU"


def _hf_cache_dirs() -> list[Path]:
    """Onde o faster-whisper guarda os modelos baixados."""
    explicit = os.environ.get("HUGGINGFACE_HUB_CACHE") or os.environ.get("HF_HUB_CACHE")
    if explicit:
        return [Path(explicit)]
    home = os.environ.get("HF_HOME")
    if home:
        return [Path(home) / "hub"]
    return [Path.home() / ".cache" / "huggingface" / "hub"]


def _probe_whisper_model() -> tuple[bool, str]:
    model = settings.whisper_model
    for cache in _hf_cache_dirs():
        if not cache.is_dir():
            continue
        for entry in cache.glob(f"models--*--faster-whisper-{model}"):
            if any(entry.glob("snapshots/*/model.bin")):
                return True, f"baixado em {entry}"
    return False, f"'{model}' ainda nao foi baixado (~3 GB no primeiro uso)"


def _probe_ollama() -> tuple[bool, str]:
    import httpx

    host = settings.ollama_host.rstrip("/")
    try:
        httpx.get(f"{host}/api/tags", timeout=5.0).raise_for_status()
    except httpx.HTTPError:
        if _ollama_bin() is None:
            return False, f"Ollama nao instalado (nada respondendo em {host})"
        return False, f"Ollama instalado, mas o servico nao respondeu em {host}"
    return True, f"servico no ar em {host}"


def _probe_ollama_model() -> tuple[bool, str]:
    import httpx

    host = settings.ollama_host.rstrip("/")
    try:
        response = httpx.get(f"{host}/api/tags", timeout=5.0)
        response.raise_for_status()
    except httpx.HTTPError:
        return False, "servico do Ollama fora do ar"

    installed = [m.get("name", "") for m in response.json().get("models", [])]
    if settings.ollama_model in installed:
        return True, f"{settings.ollama_model} pronto"
    return False, f"'{settings.ollama_model}' ainda nao foi baixado (~5 GB)"


def _ollama_bin() -> str | None:
    """Caminho do executavel do Ollama, mesmo recem-instalado fora do PATH.

    O winget instala em `%LOCALAPPDATA%\\Programs\\Ollama` e so coloca a pasta
    no PATH de sessoes novas — o processo do backend, que ja esta de pe, nao
    veria o binario ate reiniciar.
    """
    found = shutil.which("ollama")
    if found:
        return found

    candidates = [
        Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe",
        Path("/usr/local/bin/ollama"),
        Path("/opt/homebrew/bin/ollama"),
    ]
    return next((str(c) for c in candidates if c.is_file()), None)


PROBES: dict[str, Callable[[], tuple[bool, str]]] = {
    "ffmpeg": _probe_ffmpeg,
    "nvenc": _probe_nvenc,
    "whisper_cuda": _probe_whisper_cuda,
    "whisper_model": _probe_whisper_model,
    "ollama": _probe_ollama,
    "ollama_model": _probe_ollama_model,
}


def _ffmpeg_steps() -> list[Step]:
    """O build completo do Gyan ja vem com NVENC; os de distro, nem sempre."""
    if IS_WINDOWS:
        return [
            Step(
                "Instalando o FFmpeg (build completo, com NVENC)",
                [
                    "winget", "install", "--id", "Gyan.FFmpeg", "-e",
                    "--accept-source-agreements", "--accept-package-agreements",
                ],
            )
        ]
    if IS_MAC:
        return [Step("Instalando o FFmpeg via Homebrew", ["brew", "install", "ffmpeg"])]
    return [
        Step("Atualizando a lista de pacotes", ["sudo", "apt-get", "update"], optional=True),
        Step("Instalando o FFmpeg", ["sudo", "apt-get", "install", "-y", "ffmpeg"]),
    ]


def _ollama_steps() -> list[Step]:
    """Instalar e subir sao problemas diferentes, com consertos diferentes.

    Se o binario ja existe, reinstalar nao adianta nada: o que falta e o
    servico de pe. Nesse caso o plano so sobe o `ollama serve`.
    """
    existing = _ollama_bin()
    if existing is not None:
        return [Step("Subindo o servico do Ollama", [existing, "serve"], background=True)]

    if IS_WINDOWS:
        return [
            Step(
                "Instalando o Ollama",
                [
                    "winget", "install", "--id", "Ollama.Ollama", "-e",
                    "--accept-source-agreements", "--accept-package-agreements",
                ],
            )
        ]
    if IS_MAC:
        return [Step("Instalando o Ollama via Homebrew", ["brew", "install", "ollama"])]
    return [Step("Instalando o Ollama", ["/bin/sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"])]


def catalog() -> list[Requirement]:
    """Os requisitos, na ordem em que fazem sentido resolver."""
    ffmpeg_tutorial_windows = [
        "Abra o PowerShell e rode: winget install --id Gyan.FFmpeg -e",
        "Feche e reabra o terminal para o PATH novo valer.",
        "Confirme com: ffmpeg -version",
    ]
    ffmpeg_tutorial_unix = [
        "Linux (Debian/Ubuntu): sudo apt-get install -y ffmpeg",
        "macOS: brew install ffmpeg",
        "Confirme com: ffmpeg -version",
    ]

    return [
        Requirement(
            id="ffmpeg",
            label="FFmpeg",
            summary="O motor de corte, encode e queima de legenda.",
            why="Sem ele nenhum arquivo de video e gerado.",
            tutorial=ffmpeg_tutorial_windows if IS_WINDOWS else ffmpeg_tutorial_unix,
            docs_url="https://ffmpeg.org/download.html",
            steps=_ffmpeg_steps(),
            needs_restart=True,
        ),
        Requirement(
            id="nvenc",
            label="h264_nvenc",
            summary="Encoder de video pela GPU Nvidia.",
            why=(
                "NVENC nao e um programa separado: e um encoder compilado dentro do FFmpeg. "
                "Se o seu build nao tem, o corte sai igual, so que pela CPU — de minutos "
                "para dezenas de minutos por video."
            ),
            tutorial=(
                [
                    "Cheque se o seu build tem: ffmpeg -hide_banner -encoders | findstr nvenc",
                    "Se nao aparecer nada, troque por um build completo:",
                    "  winget install --id Gyan.FFmpeg -e --force",
                    "Voce precisa de driver Nvidia 570+ e uma GPU GTX 10xx ou mais nova.",
                    "Reinicie o backend e confirme aqui no diagnostico.",
                ]
                if IS_WINDOWS
                else [
                    "Cheque se o seu build tem: ffmpeg -hide_banner -encoders | grep nvenc",
                    "Builds de distro costumam vir sem NVENC. Use o build estatico oficial:",
                    "  https://johnvansickle.com/ffmpeg/  (ja vem com nvenc)",
                    "Voce precisa do driver proprietario da Nvidia (nao o nouveau).",
                ]
            ),
            docs_url="https://docs.nvidia.com/video-technologies/video-codec-sdk/12.0/ffmpeg-with-nvidia-gpu/",
            steps=(
                [
                    Step(
                        "Reinstalando o FFmpeg com o build completo",
                        [
                            "winget", "install", "--id", "Gyan.FFmpeg", "-e", "--force",
                            "--accept-source-agreements", "--accept-package-agreements",
                        ],
                    )
                ]
                if IS_WINDOWS
                else []
            ),
            depends_on="ffmpeg",
            needs_restart=True,
        ),
        Requirement(
            id="whisper_cuda",
            label="Whisper na GPU (CUDA)",
            summary="cuBLAS + cuDNN, as libs que o CTranslate2 procura.",
            why=(
                "O faster-whisper nao usa PyTorch: ele precisa das libs CUDA soltas. "
                "Sem elas a transcricao cai para a CPU e uma live de 2 h leva horas "
                "em vez de minutos."
            ),
            tutorial=[
                "As libs vem de wheels do pip, nao do instalador do CUDA Toolkit:",
                "  pip install nvidia-cublas-cu12 nvidia-cudnn-cu12",
                "O modulo app/utils/cuda.py poe essas pastas no PATH sozinho no import.",
                "Se voce ja tem CUDA 12 + cuDNN 9 instalados no sistema, nao precisa dos wheels.",
                "Confirme que o driver esta vivo com: nvidia-smi",
            ],
            docs_url="https://github.com/SYSTRAN/faster-whisper#gpu",
            steps=[
                Step(
                    "Instalando cuBLAS e cuDNN (wheels da Nvidia)",
                    [
                        sys.executable, "-m", "pip", "install", "--upgrade",
                        "nvidia-cublas-cu12==12.6.4.1", "nvidia-cudnn-cu12==9.6.0.74",
                    ],
                )
            ],
            needs_restart=True,
        ),
        Requirement(
            id="whisper_model",
            label=f"Modelo {settings.whisper_model}",
            summary="Os pesos do Whisper, baixados uma vez e cacheados.",
            why="Sem o modelo em disco a primeira transcricao trava baixando ~3 GB.",
            tutorial=[
                "O download acontece sozinho na primeira transcricao — so demora.",
                "Para adiantar agora, rode na raiz do projeto:",
                f'  python -c "from faster_whisper import WhisperModel; WhisperModel(\'{settings.whisper_model}\')"',
                f"Fica em: {_hf_cache_dirs()[0]}",
                "Com menos de 8 GB de VRAM, troque WHISPER_MODEL para 'medium' no .env.",
            ],
            docs_url="https://huggingface.co/Systran/faster-whisper-large-v3",
            steps=[
                Step(
                    f"Baixando os pesos de {settings.whisper_model} (~3 GB)",
                    [
                        sys.executable, "-c",
                        "from huggingface_hub import snapshot_download;"
                        f"snapshot_download('Systran/faster-whisper-{settings.whisper_model}')",
                    ],
                )
            ],
        ),
        Requirement(
            id="ollama",
            label="Ollama",
            summary="O runtime de LLM local que escolhe os melhores trechos.",
            why=(
                "Sem ele a selecao cai no modo heuristico (so energia de audio), "
                "que acerta bem menos o momento do corte."
            ),
            tutorial=(
                [
                    "Instale: winget install --id Ollama.Ollama -e",
                    "O instalador ja registra o servico; ele sobe junto com o Windows.",
                    "Confirme com: ollama list",
                    f"O ClipForge procura o servico em {settings.ollama_host} (LLM_PROVIDER=ollama no .env).",
                ]
                if IS_WINDOWS
                else [
                    "Linux: curl -fsSL https://ollama.com/install.sh | sh",
                    "macOS: brew install ollama && brew services start ollama",
                    "Confirme com: ollama list",
                    f"O ClipForge procura o servico em {settings.ollama_host}.",
                ]
            ),
            docs_url="https://ollama.com/download",
            steps=_ollama_steps(),
            needs_restart=_ollama_bin() is None,
            wait_seconds=25.0,
        ),
        Requirement(
            id="ollama_model",
            label=settings.ollama_model,
            summary="O modelo que le a transcricao e pontua os trechos.",
            why="O Ollama instalado vem vazio: sem puxar um modelo, nao ha o que rodar.",
            tutorial=[
                f"Rode: ollama pull {settings.ollama_model}",
                "Ou use a lista de modelos logo abaixo, que baixa e troca sem sair daqui.",
                "Modelo grande escolhe melhor o corte; modelo pequeno cabe em GPU menor",
                "  e responde mais rapido — a lista compara os dois lados.",
                "Confirme com: ollama list",
            ],
            docs_url="https://ollama.com/library",
            steps=[
                Step(
                    f"Baixando {settings.ollama_model} (~5 GB)",
                    [_ollama_bin() or "ollama", "pull", settings.ollama_model],
                )
            ],
            depends_on="ollama",
        ),
    ]


def _requirement(requirement_id: str) -> Requirement | None:
    return next((r for r in catalog() if r.id == requirement_id), None)


def status() -> list[dict[str, Any]]:
    """Catalogo + resultado da sonda de cada item, pronto para a interface."""
    results: dict[str, bool] = {}
    payload: list[dict[str, Any]] = []

    for requirement in catalog():
        try:
            ok, detail = PROBES[requirement.id]()
        except Exception as exc:  # pragma: no cover - depende do ambiente
            logger.debug("Sonda de %s falhou: %s", requirement.id, exc)
            ok, detail = False, f"nao foi possivel checar: {exc}"

        results[requirement.id] = ok
        blocked = bool(requirement.depends_on) and not results.get(requirement.depends_on, False)

        payload.append(
            {
                "id": requirement.id,
                "label": requirement.label,
                "summary": requirement.summary,
                "why": requirement.why,
                "ok": ok,
                "detail": detail,
                "tutorial": requirement.tutorial,
                "docs_url": requirement.docs_url,
                "commands": [" ".join(step.command) for step in requirement.steps],
                # Sem plano para esta plataforma, ou faltando o que ele depende.
                "can_install": bool(requirement.steps) and not blocked,
                "blocked_by": requirement.depends_on if blocked else None,
                "needs_restart": requirement.needs_restart,
            }
        )

    return payload


# ---------------------------------------------------------------------------
# Execucao dos planos
# ---------------------------------------------------------------------------


@dataclass
class Task:
    """Uma instalacao em andamento, com o log que a interface acompanha."""

    id: str
    requirement_id: str
    status: str = "running"  # running | completed | failed
    log: list[str] = field(default_factory=list)
    error: str | None = None
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    needs_restart: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "requirement_id": self.requirement_id,
            "status": self.status,
            "log": self.log,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "needs_restart": self.needs_restart,
        }


_tasks: dict[str, Task] = {}
_lock = threading.Lock()

MAX_LOG_LINES = 400


def running_for(requirement_id: str) -> Task | None:
    """Instalacao ja em andamento para este requisito, se houver."""
    with _lock:
        return next(
            (t for t in _tasks.values() if t.requirement_id == requirement_id and t.status == "running"),
            None,
        )


def get_task(task_id: str) -> Task | None:
    with _lock:
        return _tasks.get(task_id)


def start_install(requirement_id: str) -> Task:
    """Dispara o plano do requisito numa thread e devolve a tarefa.

    Raises:
        KeyError: id fora do catalogo.
        ValueError: sem plano nesta plataforma, ou dependencia ainda pendente.
    """
    requirement = _requirement(requirement_id)
    if requirement is None:
        raise KeyError(requirement_id)
    if not requirement.steps:
        raise ValueError(f"'{requirement_id}' nao tem instalacao automatica nesta plataforma.")

    # Rodar `ollama pull` com o servico fora do ar so gasta tempo e confunde o
    # log. A interface ja esconde o botao; aqui e o endpoint que recusa.
    if requirement.depends_on:
        blocked, detail = PROBES[requirement.depends_on]()
        if not blocked:
            raise ValueError(
                f"Resolva '{requirement.depends_on}' antes: {detail}"
            )

    task = Task(id=uuid.uuid4().hex[:12], requirement_id=requirement_id, needs_restart=requirement.needs_restart)
    with _lock:
        _tasks[task.id] = task

    thread = threading.Thread(
        target=_run_plan, args=(task, requirement), name=f"install-{requirement_id}", daemon=True
    )
    thread.start()
    return task


def start_pull(model: str) -> Task:
    """Baixa um modelo do Ollama com o mesmo acompanhamento das instalacoes.

    Raises:
        ValueError: Ollama ausente, ou nome fora do formato aceito.
    """
    from app.core.ollama_models import TAG_RE

    # O nome vem da interface e vira argumento de subprocess. Sem shell, mas a
    # validacao fica aqui tambem para o modulo nao depender de quem o chama.
    if not TAG_RE.match(model.strip()):
        raise ValueError(f"'{model}' nao parece um modelo do Ollama (ex.: qwen3:8b).")

    binary = _ollama_bin()
    if binary is None:
        raise ValueError("Ollama nao esta instalado nesta maquina.")

    model = model.strip()
    requirement = Requirement(
        id=f"pull:{model}",
        label=model,
        summary="",
        why="",
        tutorial=[],
        docs_url="",
        steps=[Step(f"Baixando {model}", [binary, "pull", model])],
    )

    task = Task(id=uuid.uuid4().hex[:12], requirement_id=requirement.id)
    with _lock:
        _tasks[task.id] = task

    threading.Thread(
        target=_run_plan, args=(task, requirement), name=f"pull-{model}", daemon=True
    ).start()
    return task


def _append(task: Task, line: str) -> None:
    with _lock:
        task.log.append(line)
        if len(task.log) > MAX_LOG_LINES:
            del task.log[: len(task.log) - MAX_LOG_LINES]


def _run_plan(task: Task, requirement: Requirement) -> None:
    """Roda os passos em ordem, jogando a saida de cada um no log da tarefa."""
    try:
        for step in requirement.steps:
            _append(task, f"$ {' '.join(step.command)}")

            if step.background:
                _spawn(step.command)
                _append(task, "(servico iniciado em segundo plano)")
                continue

            try:
                code = _stream(task, step.command)
            except FileNotFoundError:
                # No Windows o `filename` da excecao vem vazio, entao o nome do
                # binario sai do proprio passo.
                task.status = "failed"
                task.error = (
                    f"'{step.command[0]}' nao existe nesta maquina. Siga o tutorial manual."
                )
                _append(task, task.error)
                return

            if code != 0 and not step.optional:
                task.status = "failed"
                task.error = f"'{step.label}' terminou com codigo {code}."
                _append(task, task.error)
                return
            if code != 0:
                _append(task, f"(passo opcional falhou com codigo {code}; seguindo)")

        # Planos avulsos (baixar um modelo, por exemplo) nao tem sonda: o
        # proprio codigo de saida ja diz se deu certo.
        if requirement.id not in PROBES:
            task.status = "completed"
            return

        # A sonda diz se o plano resolveu de fato — ou se falta reiniciar o
        # backend para o processo enxergar o PATH novo.
        ok, detail = _confirm(task, requirement)
        _append(task, f"Verificacao: {'OK' if ok else 'ainda pendente'} — {detail}")
        if not ok and requirement.needs_restart:
            _append(task, "Reinicie o backend para o processo enxergar a instalacao.")

        task.status = "completed"
    except Exception as exc:  # pragma: no cover - depende do ambiente
        logger.exception("Instalacao de %s falhou", requirement.id)
        task.status = "failed"
        task.error = str(exc)
        _append(task, task.error)
    finally:
        task.finished_at = time.time()


def _confirm(task: Task, requirement: Requirement) -> tuple[bool, str]:
    """Roda a sonda, insistindo enquanto o servico recem-subido nao responde."""
    deadline = time.time() + requirement.wait_seconds
    ok, detail = PROBES[requirement.id]()

    if not ok and requirement.wait_seconds:
        _append(task, "Esperando o servico responder…")
        while not ok and time.time() < deadline:
            time.sleep(2.0)
            ok, detail = PROBES[requirement.id]()

    return ok, detail


def _spawn(command: list[str]) -> None:
    """Sobe um servico destacado, que sobrevive ao fim desta tarefa."""
    kwargs: dict[str, Any] = {
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
        "cwd": str(settings.project_root),
    }
    if IS_WINDOWS:
        kwargs["creationflags"] = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        kwargs["start_new_session"] = True

    subprocess.Popen(command, **kwargs)


def _stream(task: Task, command: list[str]) -> int:
    """Executa um comando e copia a saida, linha a linha, para o log."""
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        cwd=str(settings.project_root),
    )

    if process.stdout:
        for raw in process.stdout:
            line = raw.rstrip()
            # Instaladores desenham barra de progresso com \r; guardamos so o
            # ultimo estado de cada uma para o log nao virar um borrao.
            if line:
                _append(task, line)

    return process.wait()
