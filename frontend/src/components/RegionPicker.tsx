import { useCallback, useRef, useState } from "react";
import type { LayoutRegion } from "../lib/types";

interface Props {
  regions: LayoutRegion[];
  onChange: (regions: LayoutRegion[]) => void;
  /** Índice da faixa em foco; as outras ficam esmaecidas. */
  active: number;
  onSelect: (index: number) => void;
}

const COLORS = ["border-brand-500", "border-amber-400", "border-sky-400"];
const FILLS = ["bg-brand-500/10", "bg-amber-400/10", "bg-sky-400/10"];

type DragKind = "move" | "resize";

/**
 * Retângulos arrastáveis sobre a prévia, um por faixa do layout.
 *
 * Coordenadas são frações do frame (0-1), não pixels: a mesma região vale
 * independentemente do tamanho que o player tiver na tela ou da resolução do
 * vídeo, e é exatamente o que o backend espera receber.
 */
export function RegionPicker({ regions, onChange, active, onSelect }: Props) {
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
      // Redimensiona pelo canto inferior direito, com um mínimo utilizável.
      const width = clamp(base.width + dx, 0.08, 1 - base.x);
      const height = clamp(base.height + dy, 0.08, 1 - base.y);
      update(drag.index, { width, height });
    }
  };

  const endDrag = () => setDrag(null);

  return (
    <div
      ref={container}
      className="absolute inset-0"
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
            } cursor-move transition-opacity`}
            style={{
              left: `${region.x * 100}%`,
              top: `${region.y * 100}%`,
              width: `${region.width * 100}%`,
              height: `${region.height * 100}%`,
            }}
            onPointerDown={(event) => startDrag(event, index, "move")}
          >
            <span
              className={`absolute -top-6 left-0 whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${
                focused ? "bg-ink-950 text-slate-100" : "bg-ink-950/70 text-slate-400"
              }`}
            >
              {index + 1}. {region.label || "Faixa"}
            </span>

            {/* Alça de redimensionamento no canto inferior direito. */}
            <span
              className={`absolute -bottom-1.5 -right-1.5 h-4 w-4 cursor-nwse-resize rounded-sm border-2 ${
                COLORS[index % COLORS.length]
              } bg-ink-950`}
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
