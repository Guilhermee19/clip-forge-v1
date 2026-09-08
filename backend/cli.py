"""CLI do ClipForge.

Exemplos:

    # Gerar ao menos 3 cortes de um video do YouTube
    python backend/cli.py --input "https://www.youtube.com/watch?v=XXXX" --min-clips 3

    # Arquivo local, forcando split-screen e 8 cortes
    python backend/cli.py -i "D:/lives/podcast.mkv" --max-clips 8 --reframe split

    # So listar os trechos escolhidos, sem renderizar
    python backend/cli.py -i video.mp4 --dry-run

    # Diagnostico do ambiente (ffmpeg, NVENC, CUDA, Ollama)
    python backend/cli.py doctor

    # Subir a API + WebSocket para a interface web
    python backend/cli.py serve
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Permite `python backend/cli.py` de qualquer diretorio.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from rich.console import Console  # noqa: E402
from rich.panel import Panel  # noqa: E402
from rich.progress import (  # noqa: E402
    BarColumn,
    Progress,
    SpinnerColumn,
    TextColumn,
    TimeElapsedColumn,
)
from rich.table import Table  # noqa: E402

from app import __version__  # noqa: E402
from app.config import settings  # noqa: E402
from app.core.pipeline import PipelineOptions, run as run_pipeline  # noqa: E402
from app.utils.logging import setup_logging  # noqa: E402

console = Console()


# ---------------------------------------------------------------------------
# Comandos
# ---------------------------------------------------------------------------


def cmd_process(args: argparse.Namespace) -> int:
    """Roda a pipeline completa com uma barra de progresso no terminal."""
    options = PipelineOptions(
        min_clips=args.min_clips,
        max_clips=args.max_clips,
        language=args.language,
        reframe_mode=args.reframe,
        burn_subtitles=False if args.no_subtitles else None,
        use_cache=not args.no_cache,
        dry_run=args.dry_run,
    )

    console.print(
        Panel.fit(
            f"[bold cyan]ClipForge {__version__}[/]\n"
            f"[dim]Entrada:[/] {args.input}\n"
            f"[dim]Cortes:[/] {options.min_clips or settings.min_clips}-"
            f"{options.max_clips or settings.max_clips}   "
            f"[dim]Reframe:[/] {options.reframe_mode or settings.reframe_mode}   "
            f"[dim]LLM:[/] {settings.llm_provider}",
            border_style="cyan",
        )
    )

    with Progress(
        SpinnerColumn(),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=40),
        TextColumn("{task.percentage:>3.0f}%"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Iniciando...", total=100)

        def on_event(event: dict) -> None:
            progress.update(
                task,
                completed=event.get("progress", 0.0) * 100,
                description=event.get("message", "")[:70],
            )

        try:
            result = run_pipeline(args.input, options=options, on_event=on_event)
        except KeyboardInterrupt:
            console.print("\n[yellow]Interrompido pelo usuario.[/]")
            return 130
        except Exception as exc:
            progress.stop()
            console.print(f"\n[bold red]Falhou:[/] {exc}")
            if args.verbose:
                console.print_exception()
            return 1

    _print_results(result, dry_run=options.dry_run)
    return 0


def _print_results(result, *, dry_run: bool) -> None:
    """Tabela final com os cortes gerados."""
    table = Table(
        title="Cortes selecionados" if dry_run else "Cortes gerados",
        header_style="bold cyan",
    )
    table.add_column("#", justify="right", width=3)
    table.add_column("Inicio", justify="right", width=9)
    table.add_column("Dur.", justify="right", width=6)
    table.add_column("Score", justify="right", width=6)
    table.add_column("Titulo", overflow="fold")
    if not dry_run:
        table.add_column("Arquivo", overflow="fold", style="dim")

    rendered = {clip.candidate.id: clip for clip in result.clips}

    for index, candidate in enumerate(result.candidates, start=1):
        row = [
            str(index),
            _clock(candidate.start_time),
            f"{candidate.duration:.0f}s",
            f"{candidate.final_score * 100:.0f}",
            candidate.title,
        ]
        if not dry_run:
            clip = rendered.get(candidate.id)
            row.append(Path(clip.video_path).name if clip else "[red]falhou[/]")
        table.add_row(*row)

    console.print(table)

    if dry_run:
        console.print("[yellow]Dry run:[/] nada foi renderizado.")
    else:
        console.print(
            f"\n[green]{len(result.clips)} cortes[/] em [bold]{settings.clips_dir}[/] "
            f"([dim]{result.elapsed / 60:.1f} min de processamento[/])"
        )


def cmd_doctor(_: argparse.Namespace) -> int:
    """Verifica se o ambiente local esta pronto para processar."""
    from app.core import analyzer
    from app.utils import ffmpeg
    from app.utils.cuda import resolve_device

    table = Table(title="Diagnostico do ambiente", header_style="bold cyan")
    table.add_column("Componente")
    table.add_column("Status")
    table.add_column("Detalhe", overflow="fold")

    def row(name: str, ok: bool, detail: str) -> None:
        table.add_row(name, "[green]OK[/]" if ok else "[red]FALHA[/]", detail)

    has_ffmpeg = ffmpeg.ffmpeg_available()
    row("FFmpeg", has_ffmpeg, settings.ffmpeg_bin if has_ffmpeg else "nao encontrado no PATH")

    if has_ffmpeg:
        has_nvenc = ffmpeg.has_nvenc()
        row(
            "NVENC",
            has_nvenc,
            "h264_nvenc disponivel" if has_nvenc else "sem NVENC — o encode usara a CPU",
        )
        row("Encoder ativo", True, ffmpeg.pick_encoder())

    device = resolve_device(settings.whisper_device)
    row(
        "CUDA (Whisper)",
        device == "cuda",
        f"device={device}, modelo={settings.whisper_model}, compute={settings.whisper_compute_type}",
    )

    llm_ok, llm_message = analyzer.check_llm()
    row(f"LLM ({settings.llm_provider})", llm_ok, llm_message)

    # O yt-dlp e a dependencia que mais envelhece mal: o YouTube muda a
    # extracao de assinatura e uma versao velha para de ver os formatos.
    ytdlp_version, ytdlp_fresh = _ytdlp_status()
    row(
        "yt-dlp",
        ytdlp_fresh,
        ytdlp_version
        if ytdlp_fresh
        else f"{ytdlp_version} — desatualizado. Rode: pip install --upgrade yt-dlp",
    )

    row("Saida", True, str(settings.clips_dir))

    console.print(table)

    if not has_ffmpeg:
        console.print(
            "\n[yellow]Instale o FFmpeg:[/] "
            "Windows: [bold]winget install Gyan.FFmpeg[/] | "
            "Linux: [bold]sudo apt install ffmpeg[/]"
        )
    if not llm_ok and settings.llm_provider == "ollama":
        console.print(
            f"\n[yellow]Ollama:[/] instale em https://ollama.com e rode "
            f"[bold]ollama pull {settings.ollama_model}[/]"
        )
    return 0 if has_ffmpeg else 1


def _ytdlp_status(max_age_days: int = 120) -> tuple[str, bool]:
    """Versao do yt-dlp instalada e se ela ainda e recente o bastante.

    A versao e datada (`2026.08.19`), entao da para estimar a idade sem
    consultar a rede. Passando de ~4 meses, a chance de o YouTube ja ter
    quebrado a extracao e alta.
    """
    from datetime import date

    try:
        import yt_dlp

        version = getattr(yt_dlp.version, "__version__", "desconhecida")
    except ImportError:
        return "nao instalado", False

    try:
        year, month, day = (int(part) for part in version.split(".")[:3])
        age = (date.today() - date(year, month, day)).days
        return f"{version} ({age} dias)", age <= max_age_days
    except (ValueError, TypeError):
        # Versao fora do padrao datado (build de dev, por exemplo).
        return version, True


def cmd_serve(args: argparse.Namespace) -> int:
    """Sobe a API FastAPI com WebSockets."""
    import uvicorn

    console.print(
        Panel.fit(
            f"[bold cyan]ClipForge API[/]\n"
            f"http://{args.host}:{args.port}      [dim]docs em /docs[/]",
            border_style="cyan",
        )
    )
    uvicorn.run(
        "app.api.server:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level=settings.log_level.lower(),
    )
    return 0


# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------


def _clock(seconds: float) -> str:
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:d}:{minutes:02d}:{secs:02d}"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="clipforge",
        description="Gera cortes verticais automaticos de videos longos, 100% local.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("--version", action="version", version=f"ClipForge {__version__}")

    # Argumentos do modo padrao (processar), disponiveis sem subcomando.
    parser.add_argument("-i", "--input", help="URL do video ou caminho de arquivo local.")
    parser.add_argument("--min-clips", type=int, help="Minimo de cortes a gerar.")
    parser.add_argument("--max-clips", type=int, help="Maximo de cortes a gerar.")
    parser.add_argument("--language", help="Idioma da transcricao (ex.: pt, en).")
    parser.add_argument(
        "--reframe",
        choices=["auto", "single", "split", "center"],
        help="Estrategia de reenquadramento vertical.",
    )
    parser.add_argument(
        "--no-subtitles", action="store_true", help="Nao queimar legendas no video."
    )
    parser.add_argument(
        "--no-cache", action="store_true", help="Ignorar transcricao em cache."
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="Selecionar os cortes sem renderizar."
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Log detalhado.")

    subparsers = parser.add_subparsers(dest="command")

    doctor = subparsers.add_parser("doctor", help="Diagnostica o ambiente local.")
    doctor.set_defaults(func=cmd_doctor)

    serve = subparsers.add_parser("serve", help="Sobe a API para a interface web.")
    serve.add_argument("--host", default=settings.api_host)
    serve.add_argument("--port", type=int, default=settings.api_port)
    serve.add_argument("--reload", action="store_true", help="Recarrega ao editar o codigo.")
    serve.set_defaults(func=cmd_serve)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    setup_logging("DEBUG" if getattr(args, "verbose", False) else settings.log_level)

    if getattr(args, "func", None):
        return args.func(args)

    if not args.input:
        parser.print_help()
        return 1

    return cmd_process(args)


if __name__ == "__main__":
    raise SystemExit(main())
