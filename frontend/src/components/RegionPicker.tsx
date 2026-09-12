import { useCallback, useRef, useState } from "react";
import type { LayoutRegion } from "@/lib/types";

interface Props {
  regions: LayoutRegion[];
  onChange: (regions: LayoutRegion[]) => void;
  /** Índice da faixa em foco; as outras ficam esmaecidas. */
  active: number;
  onSelect: (index: number) => void;
  /**
   * Altura/largura que cada faixa precisa ter, dado o quanto da tela final ela
   * ocupa. Redimensionar passa a escalar a marcação em vez de deformá-la: uma
   * marcação fora dessa proporção perde pedaços no vídeo gerado.
   */
  ratioFor: (index: number) => number;
}

const COLORS = ["border-accent", "border-amber", "border-sky"];
const FILLS = ["bg-accent/10", "bg-amber/10", "bg-sky/10"];

type DragKind = "move" | "resize";

/**
 * Retângulos arrastáveis sobre a prévia, um por faixa do layout.
 *
 * Coordenadas são frações do frame (0-1), não pixels: a mesma região vale
 * independentemente do tamanho que o player tiver na tela ou da resolução do
 * vídeo, e é exatamente o que o backend espera receber.
 */
export function RegionPicker({ regions, onChange, active, onSelect, ratioFor }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    index: number;
    kind: DragKind;
    originX: number;
    originY: number;
    region: LayoutRegion;
  } | null>(null);

  const update = useCallback(
    (index: number, patch: Partial<LayoutRegion>) => {
      onChange(regions.map((r, i) => (i === index ? { ...r, ...patch } : r)));
    },
    [regions, onChange]
  );

  const startDrag = (
    event: React.PointerEvent,
    index: number,
    kind: DragKind
  ) => {
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    onSelect(index);
    setDrag({
      index,
      kind,
      originX: event.clientX,
      originY: event.clientY,
      region: regions[index],
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag || !container.current) return;

    const bounds = container.current.getBoundingClientRect();
    const dx = (event.clientX - drag.originX) / bounds.width;
    const dy = (event.clientY - drag.originY) / bounds.height;
    const base = drag.region;

    if (drag.kind === "move") {
      update(drag.index, {
        x: clamp(base.x + dx, 0, 1 - base.width),
        y: clamp(base.y + dy, 0, 1 - base.height),
      });
    } else {
      // Escala pelo canto inferior direito mantendo a proporção da faixa: o
      // arraste define a largura e a altura sai dela.
      const ratio = ratioFor(drag.index);
      const maxWidth = Math.min(1 - base.x, (1 - base.y) / ratio);
      const width = clamp(base.width + dx, 0.08, Math.max(0.08, maxWidth));
      update(drag.index, { width, height: width * ratio });
    }
  };

  const endDrag = () => setDrag(null);

  return (
    <div
      ref={container}
      // `pointer-events-none` no container deixa os controles nativos do player
      // clicaveis; so os retangulos (abaixo) reativam o ponteiro. Durante o
      // arraste o `setPointerCapture` garante que os eventos continuem vindo.
      className="pointer-events-none absolute inset-0"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {regions.map((region, index) => {
        const focused = index === active;
        return (
          <div
            key={index}
            className={`absolute border-2 ${COLORS[index % COLORS.length]} ${
              focused ? FILLS[index % FILLS.length] : "opacity-50"
            } pointer-events-auto cursor-move transition-opacity`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
            onPointerDown={(event) => startDrag(event, index, "move")}
          >
            {/* Colada no topo do frame, a etiqueta acima da caixa seria
                cortada pelo recorte do player; nesse caso ela entra. */}
            <span
              className={`absolute left-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap ${
                region.y < 0.08 ? "top-1" : "-top-7"
              } ${focused ? "bg-bg text-ink" : "bg-bg/70 text-muted"}`}
            >
              {index + 1}. {region.label || "Faixa"}
            </span>

            {/* Alça de redimensionamento no canto inferior direito. */}
            <span
              className={`absolute -right-2 -bottom-2 size-4 cursor-nwse-resize rounded-full border-2 ${
                COLORS[index % COLORS.length]
              } bg-bg`}
              onPointerDown={(event) => startDrag(event, index, "resize")}
            />
          </div>
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
