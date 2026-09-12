"""Etapa 4 da pipeline: reenquadramento inteligente 16:9 -> 9:16.

O problema: um crop vertical fixo no centro corta o rosto de quem esta falando
na metade das lives. A solucao aqui e uma *camera virtual*:

1. Amostra frames do trecho (padrao: 5 por segundo — suficiente para seguir uma
   pessoa sentada, e 6x mais barato que processar todos os frames).
2. Detecta rostos com o MediaPipe (`FaceDetection`) e, quando disponivel,
   estima a abertura da boca com o `FaceMesh` para saber quem esta falando.
3. Agrupa as deteccoes em *tracks* por proximidade espacial, para distinguir
   "duas pessoas" de "uma pessoa que se mexeu".
4. Decide o layout: `single` (uma camera seguindo o falante), `split`
   (duas pessoas empilhadas) ou `center` (nenhum rosto detectado).
5. Suaviza a trajetoria com zona morta + filtro exponencial + limite de
   velocidade, para a camera nao tremer nem dar solavancos.
6. Simplifica a curva em poucos keyframes, que o renderer transforma numa
   expressao do filtro `crop` do FFmpeg.

O resultado e um `ReframePlan` — dados puros, sem nenhum frame de video. Quem
renderiza e o `renderer.py`.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from app.config import settings
from app.models import (
    CropKeyframe,
    LayoutRegion,
    LayoutSuggestion,
    ReframeMode,
    ReframePlan,
)
from app.utils.logging import get_logger

logger = get_logger(__name__)

ProgressFn = Callable[[float, str], None]

# Distancia maxima (em fracao da largura do frame) para considerar que duas
# deteccoes em frames diferentes sao a mesma pessoa.
_TRACK_MATCH_RADIUS = 0.12

# Um track so conta como "pessoa presente" se aparecer nesta fracao dos frames.
_TRACK_MIN_PRESENCE = 0.25

# Tempo minimo que o outro falante precisa dominar para a camera trocar de alvo.
_SPEAKER_SWITCH_DELAY = 0.7


@dataclass(slots=True)
class Detection:
    """Um rosto encontrado num frame, em coordenadas normalizadas (0-1)."""

    t: float
    cx: float
    cy: float
    width: float
    height: float
    score: float
    mouth_open: float = 0.0


@dataclass(slots=True)
class Track:
    """Sequencia de deteccoes atribuidas a mesma pessoa."""

    id: int
    detections: list[Detection] = field(default_factory=list)

    @property
    def mean_x(self) -> float:
        return float(np.mean([d.cx for d in self.detections]))

    @property
    def mean_y(self) -> float:
        return float(np.mean([d.cy for d in self.detections]))

    @property
    def last(self) -> Detection:
        return self.detections[-1]

    def at(self, t: float, tolerance: float) -> Detection | None:
        """Deteccao mais proxima do instante `t`, se houver dentro da tolerancia."""
        best: Detection | None = None
        best_gap = tolerance
        for detection in self.detections:
            gap = abs(detection.t - t)
            if gap <= best_gap:
                best, best_gap = detection, gap
        return best


# ---------------------------------------------------------------------------
# Deteccao
# ---------------------------------------------------------------------------


def _mouth_openness(landmarks, frame_w: int, frame_h: int) -> tuple[float, float, float]:
    """Abertura da boca normalizada + centro do rosto, a partir do FaceMesh.

    Indices do modelo canonico do MediaPipe: 13 = labio superior interno,
    14 = labio inferior interno, 10 = topo da testa, 152 = base do queixo.
    Dividir a abertura pela altura do rosto torna a medida invariante a
    distancia da pessoa ate a camera.
    """
    points = landmarks.landmark
    upper_lip, lower_lip = points[13], points[14]
    forehead, chin = points[10], points[152]

    face_height = abs(chin.y - forehead.y) * frame_h
    mouth_gap = abs(lower_lip.y - upper_lip.y) * frame_h
    openness = mouth_gap / face_height if face_height > 1 else 0.0

    xs = [p.x for p in points]
    ys = [p.y for p in points]
    return float(np.clip(openness, 0.0, 1.0)), float(np.mean(xs)), float(np.mean(ys))


def detect_faces(
    video_path: str | Path,
    start: float,
    end: float,
    *,
    sample_fps: float | None = None,
    detect_speaker: bool = True,
    on_progress: ProgressFn | None = None,
) -> tuple[list[Detection], int, int]:
    """Amostra o trecho e devolve as deteccoes de rosto.

    Returns:
        `(deteccoes, largura, altura)` do video de origem.
    """
    import cv2
    import mediapipe as mp

    sample_fps = sample_fps or settings.reframe_sample_fps
    capture = cv2.VideoCapture(str(video_path))
    if not capture.isOpened():
        raise RuntimeError(f"Nao foi possivel abrir o video: {video_path}")

    try:
        source_fps = capture.get(cv2.CAP_PROP_FPS) or 30.0
        width = int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
        step = max(1, int(round(source_fps / sample_fps)))

        capture.set(cv2.CAP_PROP_POS_MSEC, start * 1000.0)

        face_detector = mp.solutions.face_detection.FaceDetection(
            model_selection=1,  # 1 = full range, funciona melhor em plano aberto
            min_detection_confidence=settings.reframe_min_confidence,
        )
        mesh = None
        if detect_speaker:
            mesh = mp.solutions.face_mesh.FaceMesh(
                static_image_mode=False,
                max_num_faces=2,
                refine_landmarks=False,
                min_detection_confidence=settings.reframe_min_confidence,
            )

        detections: list[Detection] = []
        frame_index = 0
        duration = max(end - start, 0.001)

        with face_detector:
            while True:
                grabbed = capture.grab()
                if not grabbed:
                    break

                position = capture.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
                if position > end:
                    break

                if frame_index % step != 0:
                    frame_index += 1
                    continue
                frame_index += 1

                ok, frame = capture.retrieve()
                if not ok:
                    break

                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                result = face_detector.process(rgb)
                if not result.detections:
                    continue

                # Abertura de boca por rosto, para escolher o falante ativo.
                mouths: list[tuple[float, float, float]] = []
                if mesh is not None:
                    mesh_result = mesh.process(rgb)
                    if mesh_result.multi_face_landmarks:
                        mouths = [
                            _mouth_openness(lm, width, height)
                            for lm in mesh_result.multi_face_landmarks
                        ]

                for raw in result.detections:
                    box = raw.location_data.relative_bounding_box
                    cx = box.xmin + box.width / 2
                    cy = box.ymin + box.height / 2

                    # Casa o rosto do FaceMesh mais proximo desta bbox.
                    mouth_open = 0.0
                    if mouths:
                        _, nearest = min(
                            (((cx - mx) ** 2 + (cy - my) ** 2), i)
                            for i, (_, mx, my) in enumerate(mouths)
                        )
                        mouth_open = mouths[nearest][0]

                    detections.append(
                        Detection(
                            t=position,
                            cx=float(np.clip(cx, 0.0, 1.0)),
                            cy=float(np.clip(cy, 0.0, 1.0)),
                            width=float(box.width),
                            height=float(box.height),
                            score=float(raw.score[0]) if raw.score else 0.0,
                            mouth_open=mouth_open,
                        )
                    )

                if on_progress:
                    on_progress(
                        min(0.99, (position - start) / duration),
                        "Detectando rostos...",
                    )

        if mesh is not None:
            mesh.close()

        return detections, width, height

    finally:
        capture.release()


# ---------------------------------------------------------------------------
# Tracking
# ---------------------------------------------------------------------------


def build_tracks(detections: list[Detection]) -> list[Track]:
    """Agrupa deteccoes em tracks por proximidade espacial.

    Deliberadamente simples: rostos numa live ficam quase parados, entao vizinho
    mais proximo com raio fixo resolve sem o custo de um tracker de verdade.
    """
    tracks: list[Track] = []

    # Agrupa por instante para tratar todos os rostos de um frame juntos.
    by_time: dict[float, list[Detection]] = {}
    for detection in detections:
        by_time.setdefault(round(detection.t, 3), []).append(detection)

    for t in sorted(by_time):
        frame_detections = sorted(by_time[t], key=lambda d: d.score, reverse=True)
        used: set[int] = set()

        for detection in frame_detections:
            best_track: Track | None = None
            best_distance = _TRACK_MATCH_RADIUS

            for track in tracks:
                if id(track) in used:
                    continue
                last = track.last
                distance = float(np.hypot(last.cx - detection.cx, last.cy - detection.cy))
                if distance < best_distance:
                    best_track, best_distance = track, distance

            if best_track is None:
                best_track = Track(id=len(tracks))
                tracks.append(best_track)

            best_track.detections.append(detection)
            used.add(id(best_track))

    return tracks


def _significant_tracks(tracks: list[Track], sampled_frames: int) -> list[Track]:
    """Mantem apenas tracks presentes em boa parte do trecho, da esquerda para a direita."""
    minimum = max(3, int(sampled_frames * _TRACK_MIN_PRESENCE))
    significant = [t for t in tracks if len(t.detections) >= minimum]
    significant.sort(key=lambda t: t.mean_x)
    return significant


# ---------------------------------------------------------------------------
# Suavizacao
# ---------------------------------------------------------------------------


def _smooth(
    times: list[float],
    targets: list[float],
    *,
    limit: float,
    alpha: float | None = None,
    deadzone: float | None = None,
) -> list[float]:
    """Filtra a trajetoria da camera: zona morta -> EMA -> limite de velocidade.

    Args:
        times: instantes de cada amostra, em segundos.
        targets: posicao desejada (canto superior esquerdo do crop) em pixels.
        limit: valor maximo da posicao (largura do frame menos a do crop).
        alpha: fator do filtro exponencial; menor = mais suave.
        deadzone: tolerancia em pixels antes de a camera comecar a andar.

    Returns:
        Posicoes suavizadas, com o mesmo tamanho da entrada.
    """
    if not targets:
        return []

    alpha = settings.reframe_smoothing if alpha is None else alpha
    deadzone = (settings.reframe_deadzone * limit) if deadzone is None else deadzone
    # Velocidade maxima da camera: metade do enquadramento por segundo.
    max_speed = max(limit, 1.0) * 0.5

    smoothed: list[float] = []
    current = float(np.clip(targets[0], 0.0, limit))
    previous_t = times[0]

    for t, target in zip(times, targets, strict=True):
        dt = max(t - previous_t, 1e-3)
        previous_t = t

        # Zona morta: ignora micro-oscilacoes da deteccao.
        if abs(target - current) > deadzone:
            desired = current + (target - current) * alpha
            # Limite de velocidade: nada de teletransporte entre cortes de camera.
            delta = float(np.clip(desired - current, -max_speed * dt, max_speed * dt))
            current += delta

        smoothed.append(float(np.clip(current, 0.0, limit)))

    return smoothed


def _simplify(times: list[float], values: list[float], tolerance: float) -> list[CropKeyframe]:
    """Reduz a curva a poucos keyframes (Ramer-Douglas-Peucker em 1D).

    A expressao do filtro `crop` cresce com o numero de keyframes, e o parser do
    FFmpeg fica lento com milhares de termos aninhados. Descartar pontos que a
    interpolacao linear ja reproduz dentro de `tolerance` pixels reduz uma live
    inteira a algumas dezenas de pontos sem diferenca visivel.
    """
    if len(values) <= 2:
        return [CropKeyframe(t=t, x=v, y=0.0) for t, v in zip(times, values, strict=True)]

    keep = [False] * len(values)
    keep[0] = keep[-1] = True
    stack = [(0, len(values) - 1)]

    while stack:
        first, last = stack.pop()
        if last <= first + 1:
            continue

        t0, t1 = times[first], times[last]
        v0, v1 = values[first], values[last]
        span = max(t1 - t0, 1e-6)

        worst_index, worst_error = -1, 0.0
        for i in range(first + 1, last):
            interpolated = v0 + (v1 - v0) * (times[i] - t0) / span
            error = abs(values[i] - interpolated)
            if error > worst_error:
                worst_index, worst_error = i, error

        if worst_error > tolerance and worst_index != -1:
            keep[worst_index] = True
            stack.append((first, worst_index))
            stack.append((worst_index, last))

    return [
        CropKeyframe(t=round(times[i], 3), x=round(values[i], 1), y=0.0)
        for i in range(len(values))
        if keep[i]
    ]


# ---------------------------------------------------------------------------
# Escolha do falante ativo
# ---------------------------------------------------------------------------


def _active_speaker_series(
    tracks: list[Track], times: list[float], tolerance: float
) -> list[int]:
    """Indice do track em foco em cada instante, com histerese.

    Sem histerese a camera trocaria de pessoa a cada frame em que a boca do
    outro abrisse um pouco mais — o resultado pareceria um pingue-pongue.
    """
    if len(tracks) == 1:
        return [0] * len(times)

    current = 0
    pending: int | None = None
    pending_since = 0.0
    series: list[int] = []

    for t in times:
        openness = []
        for track in tracks:
            detection = track.at(t, tolerance)
            openness.append(detection.mouth_open if detection else 0.0)

        leader = int(np.argmax(openness))
        # Exige uma diferenca minima para nao trocar por ruido de landmark.
        confident = openness[leader] > 0.02 and openness[leader] > max(
            [o for i, o in enumerate(openness) if i != leader] or [0.0]
        ) * 1.4

        if confident and leader != current:
            if pending != leader:
                pending, pending_since = leader, t
            elif t - pending_since >= _SPEAKER_SWITCH_DELAY:
                current, pending = leader, None
        elif leader == current:
            pending = None

        series.append(current)

    return series


# ---------------------------------------------------------------------------
# Entrada principal
# ---------------------------------------------------------------------------


def build_plan(
    video_path: str | Path,
    start: float,
    end: float,
    *,
    mode: str | None = None,
    aspect_ratio: float | None = None,
    manual_offset: float | None = None,
    regions: list[LayoutRegion] | None = None,
    camera_keys: list[tuple[float, float, float, bool]] | None = None,
    zoom: float = 1.0,
    on_progress: ProgressFn | None = None,
) -> ReframePlan:
    """Monta o plano de reenquadramento de um trecho do video.

    Args:
        video_path: video de origem (16:9 ou qualquer proporcao horizontal).
        start / end: intervalo do corte, em segundos.
        mode: `auto`, `single`, `split`, `center` ou `manual`. `None` usa o `.env`.
        aspect_ratio: proporcao alvo (largura/altura). `None` usa a do `.env`.
        manual_offset: posicao horizontal fixa do enquadramento, de 0.0
            (encostado a esquerda) a 1.0 (a direita). Quando informado, nem
            roda a deteccao de rosto — o usuario ja disse onde quer a camera.
        regions: faixas do layout composto (gameplay + webcam), de cima para
            baixo. So valem no modo `composite`.
        camera_keys: posicoes da camera ao longo do tempo, como
            `(t, centro_x, centro_y, corte_seco)`. `t` e relativo ao inicio do
            corte; o centro vai de 0 a 1 no frame de origem. So vale no modo
            `keyframe`, e tambem dispensa a deteccao de rosto.
        zoom: fecha a janela de crop (1.0 = a maior que cabe; 2.0 = metade da
            largura). Constante no corte inteiro — o FFmpeg exige tamanho de
            saida fixo, entao so a posicao pode variar no tempo.
        on_progress: callback `(fracao, mensagem)`.

    Returns:
        Um `ReframePlan` pronto para o renderer.
    """
    mode = (mode or settings.reframe_mode).lower()
    target_ratio = aspect_ratio or (settings.output_width / settings.output_height)

    # Composicao por regioes tambem dispensa deteccao: as faixas ja vieram
    # prontas da interface (ou da sugestao automatica).
    if mode == "composite":
        if not regions:
            raise ValueError("O modo 'composite' exige ao menos uma regiao.")
        from app.utils import ffmpeg as ffmpeg_utils

        info = ffmpeg_utils.probe(video_path)
        return _composite_plan(info.width, info.height, regions)

    # Camera movida a mao tambem dispensa MediaPipe: o usuario ja disse onde a
    # janela fica em cada instante.
    if mode == "keyframe":
        if not camera_keys:
            raise ValueError("O modo 'keyframe' exige ao menos uma posicao de camera.")
        from app.utils import ffmpeg as ffmpeg_utils

        info = ffmpeg_utils.probe(video_path)
        return _keyframe_plan(info.width, info.height, target_ratio, camera_keys, zoom)

    # Enquadramento manual dispensa MediaPipe: e uma janela fixa.
    if manual_offset is not None or mode == "manual":
        from app.utils import ffmpeg as ffmpeg_utils

        info = ffmpeg_utils.probe(video_path)
        return _manual_plan(
            info.width, info.height, target_ratio, manual_offset if manual_offset is not None else 0.5
        )

    detections, source_w, source_h = ([], 0, 0)
    if mode != "center":
        detections, source_w, source_h = detect_faces(
            video_path, start, end, on_progress=on_progress
        )

    if not source_w or not source_h:
        from app.utils import ffmpeg as ffmpeg_utils

        info = ffmpeg_utils.probe(video_path)
        source_w, source_h = info.width, info.height

    sampled_times = sorted({round(d.t, 3) for d in detections})
    tracks = _significant_tracks(build_tracks(detections), len(sampled_times))

    logger.info(
        "Reframe %.1fs-%.1fs: %d deteccoes, %d pessoa(s) estavel(is)",
        start,
        end,
        len(detections),
        len(tracks),
    )

    # ---------------------------------------------------------- sem rostos
    if not tracks or mode == "center":
        return _center_plan(source_w, source_h, target_ratio, len(tracks))

    # ------------------------------------------------------ split-screen
    #
    # Duas pessoas bem separadas na horizontal rendem mais empilhadas do que com
    # a camera pulando de uma para a outra.
    wants_split = mode == "split" or (
        mode == "auto"
        and len(tracks) >= 2
        and abs(tracks[0].mean_x - tracks[-1].mean_x) > 0.22
    )
    if wants_split and len(tracks) >= 2:
        return _split_plan(tracks, sampled_times, source_w, source_h, start, end)

    # ------------------------------------------------ camera unica (single)
    return _single_plan(tracks, sampled_times, source_w, source_h, target_ratio, start, end)


def suggest_layout(
    video_path: str | Path,
    start: float,
    end: float,
    *,
    sample_seconds: float = 6.0,
) -> LayoutSuggestion:
    """Analisa o trecho e recomenda um layout de saida.

    Le apenas alguns segundos do meio do corte — o suficiente para saber quantas
    pessoas aparecem e onde, sem pagar o custo de varrer o trecho inteiro.

    A regra que mais importa e a do corte de gameplay: quando ha um unico rosto
    pequeno e encostado numa borda, e quase certo que seja uma webcam sobre a
    captura de tela. Nesse caso, um crop vertical simples jogaria fora o jogo ou
    a pessoa; o certo e empilhar os dois.
    """
    middle = start + (end - start) / 2
    window_start = max(start, middle - sample_seconds / 2)
    window_end = min(end, window_start + sample_seconds)

    detections, source_w, source_h = detect_faces(
        video_path, window_start, window_end, detect_speaker=False
    )
    sampled = sorted({round(d.t, 3) for d in detections})
    tracks = _significant_tracks(build_tracks(detections), len(sampled))

    # ------------------------------------------------------ nenhum rosto
    if not tracks:
        return LayoutSuggestion(
            mode="center",
            aspect_ratio="9:16",
            reason="Nenhum rosto detectado no trecho; o crop central preserva o meio da tela.",
            confidence=0.4,
            faces_detected=0,
        )

    # ------------------------------------------------- webcam + gameplay
    if len(tracks) == 1:
        face = tracks[0]
        widths = [d.width for d in face.detections]
        face_width = float(np.median(widths))
        cx, cy = face.mean_x, face.mean_y

        # Rosto pequeno = a pessoa nao ocupa o quadro; encostado na borda =
        # provavelmente um overlay de webcam num canto.
        is_small = face_width < 0.16
        near_edge = min(cx, 1 - cx) < 0.3 or min(cy, 1 - cy) < 0.3

        if is_small and near_edge:
            return LayoutSuggestion(
                mode="composite",
                aspect_ratio="9:16",
                reason=(
                    "Rosto pequeno junto da borda: parece webcam sobre captura de tela. "
                    "O layout empilha o conteudo principal e a webcam."
                ),
                confidence=0.8,
                regions=_gameplay_regions(face, source_w, source_h),
                faces_detected=1,
            )

        return LayoutSuggestion(
            mode="single",
            aspect_ratio="9:16",
            reason="Uma pessoa em quadro: a camera virtual acompanha o rosto.",
            confidence=0.85,
            faces_detected=1,
        )

    # ------------------------------------------------------ duas pessoas
    spread = abs(tracks[0].mean_x - tracks[-1].mean_x)
    if spread > 0.22:
        return LayoutSuggestion(
            mode="split",
            aspect_ratio="9:16",
            reason=f"{len(tracks)} pessoas afastadas na horizontal; split-screen mostra as duas.",
            confidence=0.8,
            faces_detected=len(tracks),
        )

    return LayoutSuggestion(
        mode="single",
        aspect_ratio="9:16",
        reason=f"{len(tracks)} pessoas proximas; uma camera unica cobre as duas.",
        confidence=0.6,
        faces_detected=len(tracks),
    )


def _gameplay_regions(face: Track, source_w: int, source_h: int) -> list[LayoutRegion]:
    """Propoe as duas faixas de um corte de gameplay: conteudo e webcam.

    A faixa da webcam e um retangulo em volta do rosto, generoso o bastante para
    pegar ombros e cenario. A do conteudo pega a area central da tela, que e
    onde a acao costuma acontecer.
    """
    widths = [d.width for d in face.detections]
    heights = [d.height for d in face.detections]
    face_w = float(np.median(widths))
    face_h = float(np.median(heights))

    # A janela da webcam tem 4:3 e cerca de 3x a largura do rosto.
    cam_w = float(np.clip(face_w * 3.2, 0.18, 0.5))
    cam_h = float(np.clip(face_h * 3.0, 0.2, 0.6))
    cam_x = float(np.clip(face.mean_x - cam_w / 2, 0.0, 1.0 - cam_w))
    cam_y = float(np.clip(face.mean_y - cam_h * 0.45, 0.0, 1.0 - cam_h))

    # O conteudo ocupa a maior parte da tela; recortamos o centro dela.
    content_w = 0.7
    content_h = 0.62
    content_x = float(np.clip(0.5 - content_w / 2, 0.0, 1.0 - content_w))
    # Empurra o recorte do conteudo para o lado oposto ao da webcam, para nao
    # repetir a mesma area nas duas faixas.
    if face.mean_x < 0.5:
        content_x = min(1.0 - content_w, content_x + 0.12)
    else:
        content_x = max(0.0, content_x - 0.12)
    content_y = float(np.clip(0.5 - content_h / 2, 0.0, 1.0 - content_h))

    return [
        LayoutRegion(
            x=round(content_x, 4),
            y=round(content_y, 4),
            width=round(content_w, 4),
            height=round(content_h, 4),
            weight=0.62,
            label="Conteudo",
        ),
        LayoutRegion(
            x=round(cam_x, 4),
            y=round(cam_y, 4),
            width=round(cam_w, 4),
            height=round(cam_h, 4),
            weight=0.38,
            label="Webcam",
        ),
    ]


def _composite_plan(
    source_w: int, source_h: int, regions: list[LayoutRegion]
) -> ReframePlan:
    """Plano de composicao: varias faixas do frame empilhadas na vertical."""
    normalized = _normalize_weights(regions)
    return ReframePlan(
        mode=ReframeMode.COMPOSITE,
        source_width=source_w,
        source_height=source_h,
        crop_width=source_w,
        crop_height=source_h,
        regions=normalized,
        faces_detected=0,
    )


def _normalize_weights(regions: list[LayoutRegion]) -> list[LayoutRegion]:
    """Garante que os pesos das faixas somem 1.0."""
    total = sum(max(r.weight, 0.0) for r in regions)
    if total <= 0:
        share = 1.0 / max(len(regions), 1)
        return [
            LayoutRegion(r.x, r.y, r.width, r.height, share, r.label) for r in regions
        ]
    return [
        LayoutRegion(r.x, r.y, r.width, r.height, max(r.weight, 0.0) / total, r.label)
        for r in regions
    ]


def _crop_size(source_w: int, source_h: int, target_ratio: float) -> tuple[int, int]:
    """Maior janela com a proporcao pedida que cabe dentro do frame de origem."""
    crop_w = _even(min(source_w, source_h * target_ratio))
    crop_h = _even(min(source_h, crop_w / target_ratio))
    return crop_w, crop_h


def _manual_plan(
    source_w: int, source_h: int, target_ratio: float, offset: float
) -> ReframePlan:
    """Janela fixa na posicao horizontal escolhida pelo usuario.

    `offset` e a fracao do curso disponivel: 0.0 encosta o enquadramento na
    borda esquerda, 1.0 na direita, 0.5 centraliza.
    """
    crop_w, crop_h = _crop_size(source_w, source_h, target_ratio)
    travel = max(source_w - crop_w, 0)
    x = float(np.clip(offset, 0.0, 1.0)) * travel

    return ReframePlan(
        mode=ReframeMode.MANUAL,
        source_width=source_w,
        source_height=source_h,
        crop_width=crop_w,
        crop_height=crop_h,
        keyframes=[CropKeyframe(t=0.0, x=x, y=(source_h - crop_h) / 2)],
        faces_detected=0,
    )


def _keyframe_plan(
    source_w: int,
    source_h: int,
    target_ratio: float,
    keys: list[tuple[float, float, float, bool]],
    zoom: float,
) -> ReframePlan:
    """Janela movida a mao: uma posicao por instante marcado na interface.

    O `zoom` vale para o corte inteiro porque o FFmpeg exige que o `crop` tenha
    tamanho constante — o que varia no tempo e so onde a janela esta.
    """
    zoom = float(np.clip(zoom, 1.0, 4.0))
    base_w, base_h = _crop_size(source_w, source_h, target_ratio)
    crop_w = _even(min(base_w, base_w / zoom))
    crop_h = _even(min(source_h, crop_w / target_ratio))

    max_x = max(source_w - crop_w, 0)
    max_y = max(source_h - crop_h, 0)

    frames: list[CropKeyframe] = []
    for t, center_x, center_y, hold in sorted(keys, key=lambda k: k[0]):
        frames.append(
            CropKeyframe(
                t=max(0.0, float(t)),
                # O usuario aponta o centro do enquadramento; o crop quer o
                # canto superior esquerdo.
                x=float(np.clip(float(center_x) * source_w - crop_w / 2, 0, max_x)),
                y=float(np.clip(float(center_y) * source_h - crop_h / 2, 0, max_y)),
                hold=bool(hold),
            )
        )

    # Sem um ponto em t=0, o FFmpeg extrapolaria o primeiro trecho para tras e a
    # camera comecaria fora do lugar marcado.
    if frames[0].t > 0.0:
        first = frames[0]
        frames.insert(0, CropKeyframe(t=0.0, x=first.x, y=first.y, hold=True))

    return ReframePlan(
        mode=ReframeMode.KEYFRAME,
        source_width=source_w,
        source_height=source_h,
        crop_width=crop_w,
        crop_height=crop_h,
        keyframes=frames,
        faces_detected=0,
    )


def _even(value: float) -> int:
    """Arredonda para o inteiro par mais proximo (exigencia do H.264)."""
    return int(round(value / 2) * 2)


def _center_plan(
    source_w: int, source_h: int, target_ratio: float, faces: int
) -> ReframePlan:
    """Crop fixo no centro, usado quando nenhum rosto e detectado."""
    crop_w = _even(min(source_w, source_h * target_ratio))
    crop_h = _even(min(source_h, crop_w / target_ratio))
    x = (source_w - crop_w) / 2

    return ReframePlan(
        mode=ReframeMode.CENTER,
        source_width=source_w,
        source_height=source_h,
        crop_width=crop_w,
        crop_height=crop_h,
        keyframes=[CropKeyframe(t=0.0, x=x, y=(source_h - crop_h) / 2)],
        faces_detected=faces,
    )


def _single_plan(
    tracks: list[Track],
    times: list[float],
    source_w: int,
    source_h: int,
    target_ratio: float,
    start: float,
    end: float,
) -> ReframePlan:
    """Uma camera virtual seguindo o falante ativo."""
    crop_w = _even(min(source_w, source_h * target_ratio))
    crop_h = _even(min(source_h, crop_w / target_ratio))
    limit = max(source_w - crop_w, 0)
    tolerance = 1.0 / max(settings.reframe_sample_fps, 1.0)

    speaker = _active_speaker_series(tracks, times, tolerance)
    targets: list[float] = []
    last_x = (source_w - crop_w) / 2

    for t, track_index in zip(times, speaker, strict=True):
        detection = tracks[track_index].at(t, tolerance)
        if detection is None:
            # Sem deteccao neste instante: segura o ultimo enquadramento em vez
            # de voltar ao centro (evita um solavanco a cada frame perdido).
            targets.append(last_x)
            continue
        # O rosto fica um pouco acima do centro do enquadramento: e onde o olho
        # espera encontra-lo, e sobra espaco embaixo para a legenda.
        last_x = float(np.clip(detection.cx * source_w - crop_w / 2, 0, limit))
        targets.append(last_x)

    smoothed = _smooth(times, targets, limit=limit)
    keyframes = _simplify(times, smoothed, tolerance=source_w * 0.004)

    # Timestamps relativos ao inicio do corte (o renderer corta antes de filtrar).
    for keyframe in keyframes:
        keyframe.t = round(max(0.0, keyframe.t - start), 3)
        keyframe.y = (source_h - crop_h) / 2

    if not keyframes:
        keyframes = [CropKeyframe(t=0.0, x=(source_w - crop_w) / 2, y=(source_h - crop_h) / 2)]

    logger.debug("Plano single: %d keyframes para %.1fs", len(keyframes), end - start)

    return ReframePlan(
        mode=ReframeMode.SINGLE,
        source_width=source_w,
        source_height=source_h,
        crop_width=crop_w,
        crop_height=crop_h,
        keyframes=keyframes,
        faces_detected=len(tracks),
    )


def _split_plan(
    tracks: list[Track],
    times: list[float],
    source_w: int,
    source_h: int,
    start: float,
    end: float,
) -> ReframePlan:
    """Duas pessoas empilhadas: cada metade da tela vertical recebe uma delas.

    Cada painel tem metade da altura da saida, entao a proporcao de cada crop e
    `largura / (altura / 2)` — 1.125 numa saida 1080x1920.
    """
    panel_ratio = settings.output_width / (settings.output_height / 2)
    crop_h = _even(min(source_h, source_w / panel_ratio))
    crop_w = _even(min(source_w, crop_h * panel_ratio))
    limit = max(source_w - crop_w, 0)
    tolerance = 1.0 / max(settings.reframe_sample_fps, 1.0)

    top_track, bottom_track = tracks[0], tracks[-1]
    lanes: list[list[CropKeyframe]] = []

    for track in (top_track, bottom_track):
        targets: list[float] = []
        last_x = float(np.clip(track.mean_x * source_w - crop_w / 2, 0, limit))
        for t in times:
            detection = track.at(t, tolerance)
            if detection is not None:
                last_x = float(np.clip(detection.cx * source_w - crop_w / 2, 0, limit))
            targets.append(last_x)

        smoothed = _smooth(times, targets, limit=limit)
        keyframes = _simplify(times, smoothed, tolerance=source_w * 0.004)
        for keyframe in keyframes:
            keyframe.t = round(max(0.0, keyframe.t - start), 3)
            keyframe.y = (source_h - crop_h) / 2
        lanes.append(keyframes or [CropKeyframe(t=0.0, x=limit / 2, y=(source_h - crop_h) / 2)])

    logger.debug("Plano split: %d + %d keyframes", len(lanes[0]), len(lanes[1]))

    return ReframePlan(
        mode=ReframeMode.SPLIT,
        source_width=source_w,
        source_height=source_h,
        crop_width=crop_w,
        crop_height=crop_h,
        keyframes=lanes[0],
        keyframes_secondary=lanes[1],
        faces_detected=len(tracks),
    )
