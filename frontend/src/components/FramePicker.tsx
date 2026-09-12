import { useRef, useState } from "react";
import { Lock, Move } from "lucide-react";
import { clamp, cropOrigin, type CropWindow } from "@/lib/camera";
import { cn } from "@/lib/cn";

interface Props {
  /** Tamanho da janela de crop, em frações do frame (0-1). */
  window: CropWindow;
  /** Centro atual do enquadramento, em frações do frame. */
  center: { x: number; y: number };
  onMove: (center: { x: number; y: number }) => void;
  /** Redimensionar equivale a mudar o zoom: a proporção é travada. */
  onZoom?: (zoom: number) => void;
  zoom: number;
  /** Largura da janela sem zoom, para converter arraste em zoom. */
  baseWidth: number;
  maxZoom?: number;
  /** Sem isto o retângulo só mostra o recorte, sem aceitar arraste. */
  editable: boolean;
}

type DragKind = "move" | "resize";

/**
 * O retângulo do enquadramento sobre o vídeo original.
 *
 * Arrastar move a câmera; a alça do canto fecha ou abre a janela. A proporção
 * fica travada na do formato de saída — uma janela fora de proporção não existe
 * no FFmpeg, o `crop` sempre sai no tamanho que o formato pede.
 */
export function FramePicker({
  window: cropSize,
  center,
  onMove,
  onZoom,
  zoom,
  baseWidth,
  maxZoom = 4,
  editable,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{
    kind: DragKind;
    originX: number;
    originY: number;
    center: { x: number; y: number };
    width: number;
  } | null>(null);

  const { left, top } = cropOrigin(center, cropSize);

  const startDrag = (event: React.PointerEvent, kind: DragKind) => {
    if (!editable) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({
      kind,
      originX: event.clientX,
      originY: event.clientY,
      center: { ...center },
      width: cropSize.width,
    });
  };

  const onPointerMove = (event: React.PointerEvent) => {
    if (!drag || !container.current) return;

    const bounds = container.current.getBoundingClientRect();
    const dx = (event.clientX - drag.originX) / bounds.width;
    const dy = (event.clientY - drag.originY) / bounds.height;

    if (drag.kind === "move") {
      onMove({
        x: clamp(drag.center.x + dx, cropSize.width / 2, 1 - cropSize.width / 2),
        y: clamp(drag.center.y + dy, cropSize.height / 2, 1 - cropSize.height / 2),
      });
      return;
    }

    // A alça puxa a borda direita, então o dobro do arraste vira largura: o
    // centro fica onde está e a janela cresce para os dois lados.
    const width = clamp(drag.width + dx * 2, baseWidth / maxZoom, baseWidth);
    onZoom?.(clamp(baseWidth / width, 1, maxZoom));
  };

  const endDrag = () => setDrag(null);

  return (
    <div
      ref={container}
      // `pointer-events-none` no container deixa os controles nativos do player
      // clicáveis; só o retângulo reativa o ponteiro.
      className="pointer-events-none absolute inset-0"
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className={cn(
          "absolute border-2 border-accent",
          editable ? "pointer-events-auto cursor-move" : "cursor-default",
        )}
        style={{
          left: `${left * 100}%`,
          top: `${top * 100}%`,
          width: `${cropSize.width * 100}%`,
          height: `${cropSize.height * 100}%`,
          // Uma sombra gigante escurece tudo em volta e deixa o miolo do
          // enquadramento limpo, sem precisar de quatro divs de moldura.
          boxShadow: "0 0 0 9999px rgb(10 10 12 / 0.65)",
        }}
        onPointerDown={(event) => startDrag(event, "move")}
      >
        <span
          className={cn(
            // Encostada no topo, a etiqueta acima da caixa sairia do quadro.
            "absolute left-1 inline-flex items-center gap-1.5 rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-ink",
            top < 0.08 ? "top-1" : "-top-7",
          )}
        >
          {editable ? (
            <Move className="size-3" strokeWidth={2.4} />
          ) : (
            <Lock className="size-3" strokeWidth={2.4} />
          )}
          {zoom > 1.01 ? `${zoom.toFixed(1)}×` : "Enquadramento"}
        </span>

        {/* Linhas-guia de terços, para alinhar o rosto sem chutar. */}
        <div className="pointer-events-none absolute inset-0 opacity-40">
          <div className="absolute top-1/3 right-0 left-0 border-t border-dashed border-accent" />
          <div className="absolute top-2/3 right-0 left-0 border-t border-dashed border-accent" />
          <div className="absolute inset-y-0 left-1/3 border-l border-dashed border-accent" />
          <div className="absolute inset-y-0 left-2/3 border-l border-dashed border-accent" />
        </div>

        {editable && onZoom && (
          <span
            aria-label="Redimensionar enquadramento"
            className="pointer-events-auto absolute -right-2 -bottom-2 size-4 cursor-nwse-resize rounded-full border-2 border-accent bg-bg"
            onPointerDown={(event) => startDrag(event, "resize")}
          />
        )}
      </div>
    </div>
  );
}
