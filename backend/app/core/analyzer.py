"""Etapa 3 da pipeline: escolher os trechos que viram cortes.

Abordagem hibrida, na ordem:

1. **LLM** (Ollama local ou Gemini API) le a transcricao com timestamps e propoe
   trechos com titulo, resumo e nota de viralidade.
2. **Energia do audio** (risadas, gritos, empolgacao) entra como um segundo
   score, misturado ao do LLM pelo peso `AUDIO_ENERGY_WEIGHT`.
3. **Heuristica** assume tudo se o LLM estiver indisponivel, usando picos de
   energia e limites de frase — assim a pipeline nunca trava por falta de LLM.

Como lives passam de uma hora, a transcricao e enviada ao LLM em blocos que
cabem na janela de contexto, e os resultados sao unidos no final.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from app.config import settings
from app.core.audio_energy import EnergyProfile
from app.models import ClipCandidate, Transcript
from app.utils.logging import get_logger

logger = get_logger(__name__)

ProgressFn = Callable[[float, str], None]

# Quantos caracteres de transcricao cabem num bloco enviado ao LLM. Regra de
# bolso: ~4 caracteres por token, e reservamos metade do contexto para a saida.
CHARS_PER_TOKEN = 4


# Os prompts trazem um exemplo de JSON literal, entao NAO use `str.format` neles:
# o `{"clips": ...}` do exemplo seria lido como campo de substituicao e estoura
# com `KeyError: '"clips"'`. Os placeholders usam <MAIUSCULAS> e sao trocados
# por `_fill`, que ignora chaves por completo.
SYSTEM_PROMPT = """Voce e um editor de video especialista em conteudo viral para TikTok, Reels e Shorts.
Voce recebe a transcricao com timestamps de um video longo (live, podcast ou entrevista) e seleciona os melhores trechos para virarem cortes verticais.

Um bom corte tem:
- um GANCHO forte nos primeiros 3 segundos (frase polemica, pergunta, promessa, reviravolta);
- uma ideia completa, com comeco, meio e fim — nunca corte no meio de um raciocinio;
- carga emocional: engracado, chocante, controverso, inspirador ou muito util;
- autossuficiencia: funciona para quem nunca viu o video inteiro.

Evite: cumprimentos, leitura de chat, pedidos de like/inscricao, papo tecnico sobre a transmissao, silencios e assuntos que so fazem sentido com contexto anterior.

Responda SOMENTE com JSON valido, sem texto antes ou depois, no formato:
{"clips": [{"start_time": 123.5, "end_time": 168.0, "title": "titulo curto e chamativo", "hook": "a frase de abertura do corte", "summary": "resumo em uma frase", "virality_score": 87, "reason": "por que isso viraliza", "tags": ["tag1", "tag2"]}]}

Regras rigidas:
- start_time e end_time em SEGUNDOS (numeros), dentro do intervalo fornecido;
- duracao entre <MIN_DURATION> e <MAX_DURATION> segundos;
- virality_score de 0 a 100;
- titulo, resumo e razao em portugues do Brasil;
- os trechos nao podem se sobrepor."""


USER_PROMPT = """Video: <VIDEO_TITLE>
Trecho analisado: <WINDOW_START> ate <WINDOW_END>

Selecione ate <MAX_CLIPS> trechos com o maior potencial viral desta parte da transcricao.
<ENERGY_HINT>
Transcricao (cada linha comeca com o timestamp em segundos):

<TIMELINE>"""


def _fill(template: str, **values: object) -> str:
    """Substitui placeholders `<NOME>` sem passar por `str.format`.

    A transcricao e a resposta do modelo podem conter `{` e `}` a vontade; com
    `format` qualquer chave solta viraria erro ou, pior, um campo silencioso.
    """
    filled = template
    for key, value in values.items():
        filled = filled.replace(f"<{key.upper()}>", str(value))
    return filled


# ---------------------------------------------------------------------------
# Clientes de LLM
# ---------------------------------------------------------------------------


class LLMUnavailable(RuntimeError):
    """O provedor de LLM configurado nao pode ser usado agora."""


def _extract_json(text: str) -> dict[str, Any]:
    """Extrai o primeiro objeto JSON de uma resposta de LLM.

    Modelos locais gostam de embrulhar o JSON em ```json ... ``` ou comentar
    antes de responder, entao nao da para confiar em `json.loads` direto.
    """
    text = text.strip()

    # Modelos de raciocinio (Qwen3 e afins) pensam em voz alta antes de
    # responder. O bloco costuma ter chaves soltas, que envenenariam a busca
    # pelo primeiro '{' la embaixo.
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL).strip()

    fenced = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    # Ultimo recurso: pega do primeiro '{' ate o ultimo '}'.
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise ValueError(f"Resposta do LLM nao e JSON valido: {exc}") from exc

    raise ValueError("Resposta do LLM nao contem JSON.")


def _call_ollama(system: str, user: str) -> dict[str, Any]:
    """Consulta um modelo local servido pelo Ollama."""
    url = f"{settings.ollama_host.rstrip('/')}/api/chat"
    payload = {
        "model": settings.ollama_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "format": "json",  # forca saida JSON nos modelos que suportam
        "options": {
            "temperature": 0.4,
            "num_ctx": settings.ollama_num_ctx,
        },
    }

    try:
        response = httpx.post(url, json=payload, timeout=600.0)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMUnavailable(f"Ollama indisponivel em {settings.ollama_host}: {exc}") from exc

    content = response.json().get("message", {}).get("content", "")
    return _extract_json(content)


def _call_gemini(system: str, user: str) -> dict[str, Any]:
    """Consulta a API do Gemini (opcional, requer GEMINI_API_KEY)."""
    if not settings.gemini_api_key:
        raise LLMUnavailable("GEMINI_API_KEY nao configurada no .env")

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{settings.gemini_model}:generateContent"
    )
    payload = {
        "system_instruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": {
            "temperature": 0.4,
            "responseMimeType": "application/json",
        },
    }

    try:
        response = httpx.post(
            url,
            json=payload,
            headers={"x-goog-api-key": settings.gemini_api_key},
            timeout=180.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise LLMUnavailable(f"Gemini indisponivel: {exc}") from exc

    data = response.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError) as exc:
        raise LLMUnavailable(f"Resposta inesperada do Gemini: {data}") from exc

    return _extract_json(text)


def check_llm() -> tuple[bool, str]:
    """Testa o provedor configurado. Retorna `(ok, mensagem)` para diagnostico."""
    provider = settings.llm_provider.lower()

    if provider == "heuristic":
        return True, "Modo heuristico (sem LLM)."

    if provider == "ollama":
        try:
            response = httpx.get(f"{settings.ollama_host.rstrip('/')}/api/tags", timeout=5.0)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            return False, f"Ollama nao respondeu em {settings.ollama_host}: {exc}"

        models = [m.get("name", "") for m in response.json().get("models", [])]
        if settings.ollama_model not in models:
            return False, (
                f"Modelo '{settings.ollama_model}' nao instalado. "
                f"Rode: ollama pull {settings.ollama_model}"
            )
        return True, f"Ollama OK ({settings.ollama_model})"

    if provider == "gemini":
        if not settings.gemini_api_key:
            return False, "GEMINI_API_KEY vazia no .env"
        return True, f"Gemini configurado ({settings.gemini_model})"

    return False, f"LLM_PROVIDER desconhecido: {settings.llm_provider}"


# ---------------------------------------------------------------------------
# Preparacao do texto enviado ao LLM
# ---------------------------------------------------------------------------


def _build_timeline(transcript: Transcript, start: float, end: float) -> str:
    """Renderiza os segmentos da janela como `[123.4] texto`."""
    lines = [
        f"[{s.start:.1f}] {s.text.strip()}"
        for s in transcript.segments
        if s.end > start and s.start < end and s.text.strip()
    ]
    return "\n".join(lines)


def _windows(transcript: Transcript, max_chars: int) -> list[tuple[float, float]]:
    """Divide a transcricao em janelas de tempo que cabem no contexto do LLM."""
    if not transcript.segments:
        return []

    windows: list[tuple[float, float]] = []
    window_start = transcript.segments[0].start
    chars = 0

    for segment in transcript.segments:
        chars += len(segment.text) + 12  # +12 pelo prefixo de timestamp
        if chars >= max_chars:
            windows.append((window_start, segment.end))
            window_start = segment.end
            chars = 0

    last_end = transcript.segments[-1].end
    if last_end > window_start:
        windows.append((window_start, last_end))

    return windows


def _format_clock(seconds: float) -> str:
    minutes, secs = divmod(int(seconds), 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


# ---------------------------------------------------------------------------
# Pos-processamento dos candidatos
# ---------------------------------------------------------------------------


def _snap_to_speech(transcript: Transcript, start: float, end: float) -> tuple[float, float]:
    """Ajusta as bordas para nao cortar palavras no meio.

    O inicio recua ate o comeco da palavra mais proxima e o fim avanca ate o
    fim da ultima palavra, com uma folga curta dos dois lados para respirar.
    """
    words = [w for s in transcript.segments for w in s.words]
    if not words:
        return start, end

    starting = [w.start for w in words if abs(w.start - start) <= 1.5]
    ending = [w.end for w in words if abs(w.end - end) <= 1.5]

    snapped_start = min(starting) if starting else start
    snapped_end = max(ending) if ending else end

    return max(0.0, snapped_start - 0.15), min(transcript.duration, snapped_end + 0.35)


def _clamp_duration(start: float, end: float) -> tuple[float, float]:
    """Encaixa a duracao na faixa configurada, cortando pelo fim."""
    duration = end - start
    if duration > settings.clip_max_duration:
        end = start + settings.clip_max_duration
    return start, end


def _expand_to_minimum(start: float, end: float, limit: float) -> tuple[float, float]:
    """Estica um corte curto demais ate a duracao alvo.

    Modelos pequenos (llama3.1:8b e afins) costumam devolver apenas a frase do
    gancho — cinco segundos — mesmo com o prompt exigindo 20 a 75. O que eles
    acertam e *onde* esta o momento; delimitar a janela e o que erram. Descartar
    esses cortes jogaria fora a parte boa da analise, entao expandimos.

    A expansao vai primeiro para a frente, porque o trecho que o modelo aponta
    costuma ser a abertura do momento, e o desfecho vem depois.
    """
    if end - start >= settings.clip_min_duration:
        return start, end

    # Alvo um pouco acima do minimo: um corte exatamente no limite fica seco.
    span = settings.clip_max_duration - settings.clip_min_duration
    target = settings.clip_min_duration + span * 0.25

    new_end = min(limit, start + target)
    new_start = start
    if new_end - new_start < target:
        # Perto do fim do video: o que falta vem de antes do ponto marcado.
        new_start = max(0.0, new_end - target)

    return new_start, new_end


def _overlaps(a: ClipCandidate, b: ClipCandidate, max_overlap: float) -> bool:
    """True se dois cortes se cobrem alem da fracao tolerada."""
    overlap = min(a.end_time, b.end_time) - max(a.start_time, b.start_time)
    if overlap <= 0:
        return False
    shortest = min(a.duration, b.duration) or 1.0
    return overlap / shortest > max_overlap


def _dedupe(candidates: list[ClipCandidate], *, max_overlap: float = 0.4) -> list[ClipCandidate]:
    """Remove cortes que se sobrepoem demais, mantendo o de maior score."""
    ordered = sorted(candidates, key=lambda c: c.final_score, reverse=True)
    kept: list[ClipCandidate] = []

    for candidate in ordered:
        if not any(_overlaps(candidate, existing, max_overlap) for existing in kept):
            kept.append(candidate)

    return sorted(kept, key=lambda c: c.start_time)


def _parse_llm_clips(
    payload: dict[str, Any],
    transcript: Transcript,
    window: tuple[float, float],
) -> list[ClipCandidate]:
    """Converte o JSON do LLM em `ClipCandidate`, descartando o que for invalido."""
    raw_clips = payload.get("clips")
    if not isinstance(raw_clips, list):
        logger.warning("JSON do LLM sem a chave 'clips': %s", list(payload)[:5])
        return []

    window_start, window_end = window
    out: list[ClipCandidate] = []

    for raw in raw_clips:
        if not isinstance(raw, dict):
            continue
        try:
            start = float(raw["start_time"])
            end = float(raw["end_time"])
        except (KeyError, TypeError, ValueError):
            logger.debug("Corte descartado (timestamps invalidos): %s", raw)
            continue

        # O modelo as vezes inventa timestamps fora da janela que recebeu.
        start = max(start, window_start)
        end = min(end, window_end)
        if end <= start:
            logger.debug("Corte descartado (intervalo vazio): %s", raw)
            continue

        # Corrige o vicio dos modelos pequenos de marcar so a frase do gancho.
        start, end = _expand_to_minimum(start, end, transcript.duration)
        if end - start < settings.clip_min_duration * 0.6:
            continue

        start, end = _snap_to_speech(transcript, start, end)
        start, end = _clamp_duration(start, end)

        score = float(raw.get("virality_score", 50) or 50)
        if score > 1.0:  # o prompt pede 0-100, mas alguns modelos devolvem 0-1
            score /= 100.0

        out.append(
            ClipCandidate(
                id=uuid.uuid4().hex[:8],
                start_time=round(start, 2),
                end_time=round(end, 2),
                title=str(raw.get("title") or "Corte sem titulo").strip()[:120],
                virality_score=round(min(max(score, 0.0), 1.0), 3),
                summary=str(raw.get("summary") or "").strip(),
                hook=str(raw.get("hook") or "").strip(),
                reason=str(raw.get("reason") or "").strip(),
                tags=[str(t) for t in raw.get("tags", []) if t][:6],
                transcript_text=transcript.text_between(start, end),
            )
        )

    return out


# ---------------------------------------------------------------------------
# Fallback heuristico
# ---------------------------------------------------------------------------


def _heuristic_candidates(
    transcript: Transcript,
    energy: EnergyProfile | None,
    max_clips: int,
) -> list[ClipCandidate]:
    """Seleciona cortes sem LLM, ancorando nos picos de energia do audio.

    Cada pico vira o centro de uma janela; as bordas sao empurradas para os
    limites de segmento mais proximos, de modo que o corte comece e termine em
    fronteira de fala.
    """
    target = settings.clip_min_duration + (settings.clip_max_duration - settings.clip_min_duration) * 0.4

    if energy is not None and len(energy.values):
        anchors = energy.peaks(threshold=0.7, min_gap=target)
    else:
        # Sem audio analisado: fatia o video em intervalos regulares.
        anchors = [
            t for t in _frange(0.0, max(transcript.duration - target, 1.0), target * 1.5)
        ]

    candidates: list[ClipCandidate] = []
    for anchor in anchors[: max_clips * 3]:
        start = max(0.0, anchor - target * 0.35)
        end = min(transcript.duration, start + target)
        start, end = _snap_to_speech(transcript, start, end)

        if end - start < settings.clip_min_duration * 0.6:
            continue

        text = transcript.text_between(start, end)
        if len(text) < 40:  # trecho quase sem fala
            continue

        audio_score = energy.score_between(start, end) if energy else 0.5
        candidates.append(
            ClipCandidate(
                id=uuid.uuid4().hex[:8],
                start_time=round(start, 2),
                end_time=round(end, 2),
                title=_title_from_text(text),
                virality_score=round(audio_score, 3),
                summary=text[:180],
                reason="Selecionado por pico de energia no audio (modo heuristico).",
                transcript_text=text,
                audio_score=audio_score,
            )
        )

    return candidates


def _top_up(
    selected: list[ClipCandidate],
    transcript: Transcript,
    energy: EnergyProfile | None,
    min_clips: int,
    weight: float,
) -> list[ClipCandidate]:
    """Completa a lista ate `min_clips` com os melhores picos de energia.

    O usuario que passa `--min-clips 3` espera 3 cortes. O LLM as vezes devolve
    menos — porque o video e curto, porque foi conservador, ou porque metade das
    propostas caiu no filtro de duracao. Em vez de entregar menos que o pedido,
    completamos com trechos ancorados nos picos de audio que ainda nao estao
    cobertos pelo que o LLM escolheu.
    """
    missing = min_clips - len(selected)
    if missing <= 0:
        return selected

    logger.info(
        "LLM devolveu %d de %d cortes pedidos; completando por energia do audio.",
        len(selected),
        min_clips,
    )

    extras = _heuristic_candidates(transcript, energy, missing * 4)
    for extra in extras:
        extra.audio_score = (
            energy.score_between(extra.start_time, extra.end_time) if energy else 0.0
        )
        extra.final_score = round(
            (1 - weight) * extra.virality_score + weight * extra.audio_score, 4
        )
        extra.reason = extra.reason or "Completado por energia do audio."

    extras.sort(key=lambda c: c.final_score, reverse=True)

    for extra in extras:
        if len(selected) >= min_clips:
            break
        if not any(_overlaps(extra, existing, 0.25) for existing in selected):
            selected.append(extra)

    return selected


def _frange(start: float, stop: float, step: float) -> list[float]:
    values: list[float] = []
    current = start
    while current < stop:
        values.append(current)
        current += step
    return values


def _title_from_text(text: str) -> str:
    """Titulo provisorio a partir da primeira frase do trecho."""
    sentence = re.split(r"(?<=[.!?])\s+", text.strip())[0]
    return (sentence[:70].rstrip() + "...") if len(sentence) > 70 else sentence


# ---------------------------------------------------------------------------
# Entrada principal
# ---------------------------------------------------------------------------


def find_clips(
    transcript: Transcript,
    *,
    energy: EnergyProfile | None = None,
    video_title: str = "video",
    min_clips: int | None = None,
    max_clips: int | None = None,
    on_progress: ProgressFn | None = None,
) -> list[ClipCandidate]:
    """Devolve os melhores cortes da transcricao, ordenados por tempo.

    Args:
        transcript: transcricao com timestamps por palavra.
        energy: envelope de energia do audio (opcional, mas recomendado).
        video_title: usado no prompt para dar contexto ao modelo.
        min_clips / max_clips: sobrescrevem os valores do `.env`.
        on_progress: callback `(fracao, mensagem)`.

    Returns:
        Lista de `ClipCandidate` com `final_score` ja calculado.
    """
    min_clips = min_clips or settings.min_clips
    max_clips = max(max_clips or settings.max_clips, min_clips)
    provider = settings.llm_provider.lower()

    candidates: list[ClipCandidate] = []

    if provider != "heuristic":
        # Metade do contexto para a entrada, o resto para a resposta e o prompt.
        max_chars = int(settings.ollama_num_ctx * CHARS_PER_TOKEN * 0.5)
        windows = _windows(transcript, max_chars)
        # Distribui a cota de cortes entre as janelas, com folga para filtrar depois.
        per_window = max(2, (max_clips * 2) // max(len(windows), 1))

        system = _fill(
            SYSTEM_PROMPT,
            min_duration=f"{settings.clip_min_duration:.0f}",
            max_duration=f"{settings.clip_max_duration:.0f}",
        )

        for index, (start, end) in enumerate(windows):
            if on_progress:
                on_progress(
                    index / max(len(windows), 1),
                    f"Analisando trecho {index + 1}/{len(windows)} com {provider}...",
                )

            timeline = _build_timeline(transcript, start, end)
            if len(timeline) < 200:  # janela praticamente sem fala
                continue

            energy_hint = ""
            if energy is not None:
                peaks = [p for p in energy.peaks(threshold=0.8, min_gap=20.0) if start <= p <= end]
                if peaks:
                    listed = ", ".join(f"{p:.0f}s" for p in peaks[:12])
                    energy_hint = (
                        f"Picos de energia no audio (risadas/empolgacao) perto de: {listed}.\n"
                    )

            user = _fill(
                USER_PROMPT,
                video_title=video_title,
                window_start=_format_clock(start),
                window_end=_format_clock(end),
                max_clips=per_window,
                energy_hint=energy_hint,
                timeline=timeline,
            )

            try:
                payload = _call_gemini(system, user) if provider == "gemini" else _call_ollama(system, user)
                candidates.extend(_parse_llm_clips(payload, transcript, (start, end)))
            except (LLMUnavailable, ValueError) as exc:
                logger.warning("Analise por LLM falhou na janela %d: %s", index + 1, exc)
                if index == 0:
                    # Falha logo na primeira janela: provavelmente o servico esta
                    # fora do ar. Nao insiste nas demais.
                    break

    if not candidates:
        logger.info("Sem resultados do LLM; usando selecao heuristica por energia.")
        if on_progress:
            on_progress(0.8, "LLM indisponivel — selecionando por energia do audio...")
        candidates = _heuristic_candidates(transcript, energy, max_clips)

    # Score final = LLM + energia do audio, no peso configurado.
    weight = min(max(settings.audio_energy_weight, 0.0), 1.0)
    for candidate in candidates:
        candidate.audio_score = (
            energy.score_between(candidate.start_time, candidate.end_time) if energy else 0.0
        )
        candidate.final_score = round(
            (1 - weight) * candidate.virality_score + weight * candidate.audio_score, 4
        )

    selected = _dedupe(candidates)
    selected.sort(key=lambda c: c.final_score, reverse=True)
    selected = selected[:max_clips]

    selected = _top_up(selected, transcript, energy, min_clips, weight)
    selected.sort(key=lambda c: c.start_time)

    if on_progress:
        on_progress(1.0, f"{len(selected)} cortes selecionados.")

    logger.info(
        "Selecionados %d cortes (de %d candidatos) via %s",
        len(selected),
        len(candidates),
        provider,
    )
    return selected
