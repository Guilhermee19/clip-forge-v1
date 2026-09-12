import { useEffect, useRef } from "react";
import type { AspectRatio, LayoutRegion, ReframeMode, SubtitleStyle, Word } from "../lib/types";

interface Props {
  /** Player de origem já carregado; usamos seus frames como textura. */
  video: HTMLVideoElement | null;
  aspect: AspectRatio;
  mode: ReframeMode;
  regions: LayoutRegion[];
  manualOffset: number;
  sourceWidth: number;
  sourceHeight: number;
  words: Word[];
  subtitles: boolean;
  style: SubtitleStyle;
  /** Início do corte, para posicionar a legenda no tempo certo. */
  clipStart: number;
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
  sourceWidth,
  sourceHeight,
  words,
  subtitles,
  style,
  clipStart,
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
    words,
    subtitles,
    style,
    clipStart,
  });
  state.current = { aspect, mode, regions, manualOffset, words, subtitles, style, clipStart };

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

  return (
    <canvas
      ref={canvasRef}
      className="mx-auto max-h-[420px] rounded-lg bg-black"
      style={{ imageRendering: "auto" }}
    />
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

/** Desenha o cartão de legenda com a palavra atual destacada. */
function drawCaption(
  ctx: CanvasRenderingContext2D,
  words: Word[],
  time: number,
  outWidth: number,
  outHeight: number,
  style: SubtitleStyle
) {
  const { card, active } = cardFor(words, time, style.max_words);
  if (card.length === 0) return;

  // O estilo é definido em pixels da saída real (1920 de altura); o canvas é
  // menor, então tudo é escalado pelo mesmo fator.
  const scale = outHeight / 1920;
  const fontSize = style.font_size * scale;
  const marginV = style.margin_v * scale;

  // Mesma família que o `.ass` usa, para a prévia bater com o arquivo final.
  ctx.font = `800 ${fontSize}px Montserrat, Inter, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";

  const gap = fontSize * 0.28;
  const widths = card.map((word) => ctx.measureText(word.text.trim()).width);
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (card.length - 1);

  let x = (outWidth - total) / 2;
  const y = outHeight - marginV;

  ctx.lineWidth = Math.max(2, fontSize * 0.14);
  ctx.strokeStyle = "#000";
  ctx.lineJoin = "round";

  card.forEach((word, index) => {
    const text = word.text.trim();
    ctx.fillStyle = index === active ? style.highlight_color : style.primary_color;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
    x += widths[index] + gap;
  });
}
