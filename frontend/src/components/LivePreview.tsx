import { useEffect, useRef } from "react";
import { cropOrigin, cropWindow, sampleCamera } from "@/lib/camera";
import { cn } from "@/lib/cn";
import type {
  AspectRatio,
  CameraKeyframe,
  LayoutRegion,
  ReframeMode,
  SubtitleStyle,
  Word,
} from "@/lib/types";

interface Props {
  /** Player de origem já carregado; usamos seus frames como textura. */
  video: HTMLVideoElement | null;
  aspect: AspectRatio;
  mode: ReframeMode;
  regions: LayoutRegion[];
  manualOffset: number;
  /** Posições da câmera no tempo, usadas no modo keyframe. */
  keyframes: CameraKeyframe[];
  /** Fecha o enquadramento; constante no corte, como no FFmpeg. */
  zoom: number;
  sourceWidth: number;
  sourceHeight: number;
  words: Word[];
  subtitles: boolean;
  style: SubtitleStyle;
  /** Início do corte, para posicionar a legenda no tempo certo. */
  clipStart: number;
  /** Arrastar a legenda na prévia devolve a posição, em frações da saída. */
  onMoveCaption?: (position: { x: number; y: number }) => void;
}

/** Altura de referência do canvas; a largura sai da proporção escolhida. */
const CANVAS_HEIGHT = 640;

/**
 * Prévia ao vivo do resultado, desenhada num canvas.
 *
 * Em vez de estimar como o corte vai ficar, este componente reproduz o mesmo
 * recorte que o FFmpeg vai aplicar: `drawImage` com as coordenadas de origem é
 * o equivalente exato do filtro `crop` seguido de `scale`. O que aparece aqui é
 * o que sai no arquivo — inclusive a legenda, desenhada a partir das mesmas
 * palavras e do mesmo agrupamento que vão para o `.ass`.
 */
export function LivePreview({
  video,
  aspect,
  mode,
  regions,
  manualOffset,
  keyframes,
  zoom,
  sourceWidth,
  sourceHeight,
  words,
  subtitles,
  style,
  clipStart,
  onMoveCaption,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<number>(0);

  // Refs para os valores mutáveis: o loop de desenho roda a 60 fps e não pode
  // ser recriado a cada ajuste de slider.
  const state = useRef({
    aspect,
    mode,
    regions,
    manualOffset,
    keyframes,
    zoom,
    words,
    subtitles,
    style,
    clipStart,
  });
  state.current = {
    aspect,
    mode,
    regions,
    manualOffset,
    keyframes,
    zoom,
    words,
    subtitles,
    style,
    clipStart,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !video) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      frameRef.current = requestAnimationFrame(draw);

      const current = state.current;
      const [w, h] = current.aspect.split(":").map(Number);
      const outHeight = CANVAS_HEIGHT;
      const outWidth = Math.round((outHeight * w) / h);

      if (canvas.width !== outWidth || canvas.height !== outHeight) {
        canvas.width = outWidth;
        canvas.height = outHeight;
      }

      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, outWidth, outHeight);

      if (video.readyState < 2 || !sourceWidth) return;

      if (current.mode === "composite" && current.regions.length > 0) {
        drawBands(ctx, video, current.regions, outWidth, outHeight, sourceWidth, sourceHeight);
      } else if (current.mode === "keyframe") {
        drawKeyframed(
          ctx,
          video,
          outWidth,
          outHeight,
          sourceWidth,
          sourceHeight,
          current.keyframes,
          current.zoom,
          video.currentTime - current.clipStart
        );
      } else {
        drawSingle(
          ctx,
          video,
          outWidth,
          outHeight,
          sourceWidth,
          sourceHeight,
          current.mode === "manual" ? current.manualOffset : 0.5
        );
      }

      if (current.subtitles) {
        drawCaption(
          ctx,
          current.words,
          video.currentTime,
          outWidth,
          outHeight,
          current.style
        );
      }
    };

    frameRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frameRef.current);
  }, [video, sourceWidth, sourceHeight]);

  // O canvas aparece escalado na tela; converter pelo retângulo do elemento
  // dá a fração certa sem depender da resolução interna.
  const positionFrom = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  };

  const draggable = Boolean(onMoveCaption) && subtitles;

  return (
    <canvas
      ref={canvasRef}
      className={cn(
        "m-auto max-h-full max-w-full rounded-2xl bg-black",
        draggable && "cursor-grab touch-none active:cursor-grabbing"
      )}
      style={{ imageRendering: "auto" }}
      onPointerDown={(event) => {
        if (!draggable) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        onMoveCaption?.(positionFrom(event));
      }}
      onPointerMove={(event) => {
        if (!draggable || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onMoveCaption?.(positionFrom(event));
      }}
    />
  );
}

/**
 * Recorte que segue as posições marcadas na timeline.
 *
 * A janela é sempre do mesmo tamanho — o FFmpeg exige saída de dimensão fixa —,
 * então o que muda no tempo é só para onde ela aponta.
 */
function drawKeyframed(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  outWidth: number,
  outHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  keyframes: CameraKeyframe[],
  zoom: number,
  relativeTime: number
) {
  const size = cropWindow(sourceWidth, sourceHeight, outWidth / outHeight, zoom);
  const { left, top } = cropOrigin(sampleCamera(keyframes, relativeTime), size);

  ctx.drawImage(
    video,
    left * sourceWidth,
    top * sourceHeight,
    size.width * sourceWidth,
    size.height * sourceHeight,
    0,
    0,
    outWidth,
    outHeight
  );
}

/** Recorte único centrado (ou deslocado, no modo manual). */
function drawSingle(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  outWidth: number,
  outHeight: number,
  sourceWidth: number,
  sourceHeight: number,
  offset: number
) {
  const targetRatio = outWidth / outHeight;
  const cropWidth = Math.min(sourceWidth, sourceHeight * targetRatio);
  const cropHeight = Math.min(sourceHeight, cropWidth / targetRatio);
  const travel = sourceWidth - cropWidth;

  ctx.drawImage(
    video,
    travel * offset,
    (sourceHeight - cropHeight) / 2,
    cropWidth,
    cropHeight,
    0,
    0,
    outWidth,
    outHeight
  );
}

/**
 * Faixas empilhadas. Cada faixa preenche sua altura sem distorcer: o excedente
 * é aparado, que é o mesmo efeito do `force_original_aspect_ratio=increase`
 * seguido de `crop` no filtergraph.
 */
function drawBands(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  regions: LayoutRegion[],
  outWidth: number,
  outHeight: number,
  sourceWidth: number,
  sourceHeight: number
) {
  let y = 0;

  regions.forEach((region, index) => {
    const bandHeight =
      index === regions.length - 1 ? outHeight - y : Math.round(outHeight * region.weight);

    const sx = region.x * sourceWidth;
    const sy = region.y * sourceHeight;
    const sw = region.width * sourceWidth;
    const sh = region.height * sourceHeight;

    // Escala pelo lado que "falta" para cobrir a faixa inteira.
    const scale = Math.max(outWidth / sw, bandHeight / sh);
    const visibleWidth = outWidth / scale;
    const visibleHeight = bandHeight / scale;

    ctx.drawImage(
      video,
      sx + (sw - visibleWidth) / 2,
      sy + (sh - visibleHeight) / 2,
      visibleWidth,
      visibleHeight,
      0,
      y,
      outWidth,
      bandHeight
    );

    y += bandHeight;
  });
}

/** Agrupa palavras como o gerador de `.ass` faz, para a prévia bater com o final. */
function cardFor(words: Word[], time: number, maxWords: number): { card: Word[]; active: number } {
  if (words.length === 0) return { card: [], active: -1 };

  const groups: Word[][] = [];
  let current: Word[] = [];

  words.forEach((word, index) => {
    current.push(word);
    const last = index === words.length - 1;
    const punctuated = /[.!?,;:]$/.test(word.text.trim());
    const pause = !last && words[index + 1].start - word.end > 0.7;
    if (last || current.length >= maxWords || punctuated || pause) {
      groups.push(current);
      current = [];
    }
  });

  for (const group of groups) {
    if (time >= group[0].start && time <= group[group.length - 1].end + 0.25) {
      const active = group.findIndex((w) => time >= w.start && time <= w.end);
      return { card: group, active: active === -1 ? 0 : active };
    }
  }
  return { card: [], active: -1 };
}

/**
 * Desenha o cartão de legenda, no mesmo tipo que o `.ass` vai usar.
 *
 * Cada preset aqui espelha um `_preset_shape` do backend: `karaoke` colore a
 * palavra falada, `word` mostra uma de cada vez, `block` põe uma caixa opaca
 * atrás do texto e `clean` abre mão do destaque colorido em favor de um
 * contorno grosso.
 */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  time: number,
  outWidth: number,
  outHeight: number,
  style: SubtitleStyle
) {
  // O preset "uma palavra" é só um cartão de tamanho 1 — igual ao backend.
  const maxWords = style.preset === "word" ? 1 : style.max_words;
  const { card, active } = cardFor(words, time, maxWords);
  if (card.length === 0) return;

  // O estilo é definido em pixels da saída real (1920 de altura); o canvas é
  // menor, então tudo é escalado pelo mesmo fator.
  const scale = outHeight / 1920;
  const fontSize = style.font_size * scale;

  // Mesma família que o `.ass` usa, para a prévia bater com o arquivo final.
  ctx.font = `800 ${fontSize}px Montserrat, Inter, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const gap = fontSize * 0.28;
  const widths = card.map((word) => ctx.measureText(word.text.trim()).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (card.length - 1);

  // Com posição livre o texto é ancorado pelo centro (o `\an5\pos` do ASS);
  // sem ela, cai na margem inferior como antes.
  const centerX = style.pos_x === null ? 0.5 : style.pos_x;
  const baseline =
    style.pos_y === null
      ? outHeight - style.margin_v * scale
      : style.pos_y * outHeight + fontSize * 0.35;

  let x = centerX * outWidth - total / 2;

  if (style.preset === "block") {
    const padding = fontSize * 0.3;
    ctx.fillStyle = "#000";
    ctx.fillRect(
      x - padding,
      baseline - fontSize * 0.95,
      total + padding * 2,
      fontSize * 1.3
    );
  } else {
    ctx.lineWidth = Math.max(2, fontSize * (style.preset === "clean" ? 0.2 : 0.14));
    ctx.strokeStyle = "#000";
    ctx.lineJoin = "round";
  }

  card.forEach((word, index) => {
    const text = word.text.trim();
    const highlighted = index === active && style.preset !== "clean";

    ctx.fillStyle = highlighted ? style.highlight_color : style.primary_color;
    if (style.preset !== "block") ctx.strokeText(text, x, baseline);
    ctx.fillText(text, x, baseline);
    x += widths[index] + gap;
  });
}
