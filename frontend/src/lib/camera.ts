import type { CameraKeyframe } from "@/lib/types";

/**
 * A mesma matemática de enquadramento que o backend usa.
 *
 * A prévia só vale se ela mentir zero: o que o canvas desenha tem que ser o
 * recorte que o FFmpeg vai aplicar. Estas funções são a tradução direta de
 * `reframer._keyframe_plan` e `renderer.build_crop_expression` — se um lado
 * mudar, o outro muda junto.
 */

/** Janela de crop, em frações do frame de origem (0-1). */
export interface CropWindow {
  width: number;
  height: number;
}

/** Maior janela com a proporção pedida que cabe no frame, fechada pelo zoom. */
export function cropWindow(
  sourceWidth: number,
  sourceHeight: number,
  targetRatio: number,
  zoom = 1,
): CropWindow {
  const baseWidth = Math.min(sourceWidth, sourceHeight * targetRatio);
  const width = baseWidth / Math.max(1, zoom);
  const height = Math.min(sourceHeight, width / targetRatio);

  return { width: width / sourceWidth, height: height / sourceHeight };
}

/**
 * Onde a câmera aponta no instante `t` (segundos desde o início do corte).
 *
 * Entre dois pontos a posição desliza; quando o ponto seguinte pede corte seco
 * (`hold`), ela fica parada e salta no instante exato — que é o que dá o efeito
 * de "trocar de enquadramento" em vez de fazer um travelling.
 */
export function sampleCamera(
  keyframes: CameraKeyframe[],
  t: number,
): { x: number; y: number } {
  if (keyframes.length === 0) return { x: 0.5, y: 0.5 };

  const keys = [...keyframes].sort((a, b) => a.t - b.t);
  if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };

  const last = keys[keys.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };

  const next = keys.findIndex((key) => key.t > t);
  const from = keys[next - 1];
  const to = keys[next];

  if (to.hold) return { x: from.x, y: from.y };

  const progress = (t - from.t) / Math.max(to.t - from.t, 1e-3);
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

/** Canto superior esquerdo da janela, preso às bordas do frame. */
export function cropOrigin(
  center: { x: number; y: number },
  window: CropWindow,
): { left: number; top: number } {
  return {
    left: clamp(center.x - window.width / 2, 0, 1 - window.width),
    top: clamp(center.y - window.height / 2, 0, 1 - window.height),
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Proporção que a marcação de uma faixa precisa ter, como altura/largura em
 * frações do frame de origem.
 *
 * A faixa ocupa `weight` da altura de saída e a largura inteira, e o backend
 * preenche esse espaço cortando o excedente. Se o retângulo não tiver essa
 * proporção, parte do que você marcou some no resultado — daí ele ser travado
 * em vez de livre.
 */
export function bandRatio(
  sourceWidth: number,
  sourceHeight: number,
  outputRatio: number,
  weight: number,
): number {
  return (sourceWidth / sourceHeight) * (Math.max(weight, 0.05) / outputRatio);
}

/** Ajusta as faixas para a proporção que o peso de cada uma exige. */
export function fitBands<
  T extends { x: number; y: number; width: number; height: number; weight: number },
>(
  regions: T[],
  sourceWidth: number,
  sourceHeight: number,
  outputRatio: number,
): T[] {
  return regions.map((region) => {
    const ratio = bandRatio(sourceWidth, sourceHeight, outputRatio, region.weight);

    // Uma faixa alta pede um retângulo alto, e o frame de origem é baixo: nesse
    // caso a largura é que cede. Cortar a altura em vez disso quebraria a
    // proporção — que é o motivo de tudo isto existir.
    let width = clamp(region.width, 0.05, 1);
    let height = width * ratio;
    if (height > 1) {
      height = 1;
      width = clamp(1 / ratio, 0.05, 1);
    }

    return {
      ...region,
      width,
      height,
      x: clamp(region.x, 0, 1 - width),
      y: clamp(region.y, 0, 1 - height),
    };
  });
}

/** Um keyframe no início, para um corte que ainda não tem nenhum. */
export function defaultKeyframes(): CameraKeyframe[] {
  return [{ t: 0, x: 0.5, y: 0.5, hold: true }];
}
