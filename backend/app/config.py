"""Configuracao central da aplicacao.

Todas as opcoes vem do arquivo `.env` na raiz do projeto (veja `.env.example`).
Nenhum outro modulo deve ler variaveis de ambiente diretamente: eles importam
`settings` daqui, o que mantem um unico ponto de verdade e facilita testes.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/app -> backend -> raiz do projeto
PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """Configuracao tipada, carregada de `.env` + variaveis de ambiente."""

    model_config = SettingsConfigDict(
        env_file=PROJECT_ROOT / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---------------------------------------------------------------- paths
    output_dir: Path = Path("output")
    clips_dir: Path = Path("output/clips")
    cache_dir: Path = Path("output/cache")
    transcripts_dir: Path = Path("output/transcripts")
    uploads_dir: Path = Path("output/uploads")

    # ---------------------------------------------------------- transcricao
    whisper_model: str = "large-v3"
    whisper_device: str = "auto"
    whisper_compute_type: str = "int8_float16"
    whisper_language: str = "pt"
    whisper_beam_size: int = 5
    whisper_vad_filter: bool = True

    # ------------------------------------------------------------------ llm
    llm_provider: str = "ollama"
    ollama_host: str = "http://localhost:11434"
    ollama_model: str = "llama3.1:8b-instruct-q4_K_M"
    ollama_num_ctx: int = 8192
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.0-flash"

    # ------------------------------------------------------ selecao de corte
    min_clips: int = 5
    max_clips: int = 12
    clip_min_duration: float = 20.0
    clip_max_duration: float = 75.0
    audio_energy_weight: float = 0.25

    # -------------------------------------------------------------- reframe
    reframe_sample_fps: float = 5.0
    reframe_smoothing: float = 0.12
    reframe_deadzone: float = 0.06
    reframe_mode: str = "auto"
    reframe_min_confidence: float = 0.5

    # ------------------------------------------------------------- renderer
    ffmpeg_bin: str = "ffmpeg"
    ffprobe_bin: str = "ffprobe"
    video_encoder: str = "h264_nvenc"
    nvenc_preset: str = "p5"
    nvenc_cq: int = 21
    output_width: int = 1080
    output_height: int = 1920
    output_fps: int = 30
    audio_bitrate: str = "192k"
    burn_subtitles: bool = True

    # ------------------------------------------------------------- legendas
    subtitle_font: str = "Montserrat"
    subtitle_font_size: int = 84
    subtitle_primary_color: str = "&H00FFFFFF"
    subtitle_highlight_color: str = "&H0000E5FF"
    subtitle_outline_color: str = "&H00000000"
    subtitle_max_words_per_line: int = 4
    subtitle_margin_v: int = 420

    # ------------------------------------------------------------------ api
    api_host: str = "127.0.0.1"
    api_port: int = 8000
    max_concurrent_jobs: int = 1
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # -------------------------------------------------------------- yt-dlp
    ytdlp_format: str = "bestvideo[height<=1080]+bestaudio/best[height<=1080]"
    ytdlp_cookies: str = ""

    log_level: str = "INFO"

    # ------------------------------------------------------------ validacao
    @field_validator(
        "output_dir", "clips_dir", "cache_dir", "transcripts_dir", "uploads_dir",
        mode="after",
    )
    @classmethod
    def _absolutize(cls, value: Path) -> Path:
        """Converte caminhos relativos do .env em absolutos a partir da raiz."""
        return value if value.is_absolute() else (PROJECT_ROOT / value).resolve()

    # ------------------------------------------------------------ derivados
    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def uses_nvenc(self) -> bool:
        return "nvenc" in self.video_encoder

    @property
    def project_root(self) -> Path:
        return PROJECT_ROOT

    def ensure_dirs(self) -> None:
        """Cria todos os diretorios de trabalho, se ainda nao existirem."""
        for path in (
            self.output_dir,
            self.clips_dir,
            self.cache_dir,
            self.transcripts_dir,
            self.uploads_dir,
        ):
            path.mkdir(parents=True, exist_ok=True)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Instancia unica (cacheada) da configuracao."""
    settings = Settings()
    settings.ensure_dirs()
    return settings


settings = get_settings()
