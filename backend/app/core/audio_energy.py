"""Analise do waveform: onde o audio "acontece".

Risada, grito, aplauso e mudanca brusca de entonacao aparecem no waveform muito
antes de aparecerem no texto. Este modulo calcula um envelope de energia RMS e o
transforma num score 0-1 por janela de tempo, que depois e misturado ao score do
LLM para desempatar cortes.

Trabalhamos com PCM cru decodificado pelo ffmpeg: um podcast de 3 h em mono
16 kHz int16 ocupa ~350 MB, o que cabe folgado em 16 GB de RAM. Acima disso, o
`hop` maior mantem o vetor de energia pequeno de qualquer forma.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.utils import ffmpeg
from app.utils.logging import get_logger

logger = get_logger(__name__)

SAMPLE_RATE = 16_000


@dataclass(slots=True)
class EnergyProfile:
    """Envelope de energia amostrado em intervalos regulares."""

    hop_seconds: float
    # Energia RMS normalizada (0-1) por janela.
    values: np.ndarray

    @property
    def duration(self) -> float:
        return len(self.values) * self.hop_seconds

    def score_between(self, start: float, end: float) -> float:
        """Score 0-1 do intervalo, combinando media e pico.

        A media captura "trecho animado do inicio ao fim"; o pico captura "teve
        uma risada explosiva no meio". Os dois importam, com peso maior no pico.
        """
        if len(self.values) == 0 or end <= start:
            return 0.0

        i0 = max(0, int(start / self.hop_seconds))
        i1 = min(len(self.values), int(np.ceil(end / self.hop_seconds)))
        if i1 <= i0:
            return float(self.values[min(i0, len(self.values) - 1)])

        window = self.values[i0:i1]
        return float(np.clip(0.4 * window.mean() + 0.6 * window.max(), 0.0, 1.0))

    def peaks(self, *, threshold: float = 0.75, min_gap: float = 8.0) -> list[float]:
        """Instantes (em segundos) dos picos de energia mais destacados.

        Args:
            threshold: energia normalizada minima para considerar pico.
            min_gap: distancia minima entre dois picos, para nao devolver
                dezenas de pontos dentro da mesma risada.
        """
        if len(self.values) == 0:
            return []

        candidates = np.where(self.values >= threshold)[0]
        result: list[float] = []
        last_time = -1e9

        for index in candidates:
            t = index * self.hop_seconds
            if t - last_time >= min_gap:
                result.append(round(float(t), 2))
                last_time = t
        return result


def analyze(audio_path: str, *, hop_seconds: float = 0.5) -> EnergyProfile:
    """Calcula o envelope de energia de um arquivo de audio.

    Args:
        audio_path: caminho de qualquer arquivo legivel pelo ffmpeg.
        hop_seconds: resolucao temporal do envelope. 0.5 s e um bom meio termo
            entre detectar risadas curtas e manter o vetor pequeno.
    """
    raw = ffmpeg.decode_pcm(audio_path, sample_rate=SAMPLE_RATE)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0

    if samples.size == 0:
        logger.warning("Audio vazio em %s", audio_path)
        return EnergyProfile(hop_seconds=hop_seconds, values=np.zeros(0, dtype=np.float32))

    hop = max(1, int(SAMPLE_RATE * hop_seconds))
    usable = (samples.size // hop) * hop
    frames = samples[:usable].reshape(-1, hop)

    rms = np.sqrt(np.mean(np.square(frames), axis=1))

    # Escala em dB comprime a faixa dinamica e aproxima a percepcao humana de
    # volume; sem isso, um unico pico deixaria todo o resto perto de zero.
    db = 20.0 * np.log10(np.maximum(rms, 1e-6))

    # Normaliza contra os percentis do proprio video: o que importa e o que e
    # alto *para esta gravacao*, nao um limiar absoluto.
    floor = np.percentile(db, 10)
    ceiling = np.percentile(db, 98)
    span = max(ceiling - floor, 1e-3)
    normalized = np.clip((db - floor) / span, 0.0, 1.0).astype(np.float32)

    logger.info(
        "Envelope de energia: %d janelas de %.1fs (%.1f min de audio)",
        normalized.size,
        hop_seconds,
        normalized.size * hop_seconds / 60,
    )
    return EnergyProfile(hop_seconds=hop_seconds, values=normalized)
