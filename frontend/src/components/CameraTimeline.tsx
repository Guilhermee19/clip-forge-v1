import { useRef } from "react";
import { MoveRight, Plus, Scissors, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { clamp } from "@/lib/camera";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";
import type { CameraKeyframe } from "@/lib/types";

interface Props {
  keyframes: CameraKeyframe[];
  onChange: (keyframes: CameraKeyframe[]) => void;
  /** Duração do corte, em segundos. */
  duration: number;
  /** Posição atual do player, em segundos desde o início do corte. */
  playhead: number;
  onSeek: (relative: number) => void;
  /** Índice do keyframe em edição. */
  active: number;
  onSelect: (index: number) => void;
}

/**
 * A linha do tempo das posições de câmera.
 *
 * Cada marca é um instante em que o enquadramento muda. Entre duas marcas a
 * câmera desliza, ou fica parada e salta — o ícone de cada marca diz qual dos
 * dois, e é a diferença entre acompanhar alguém andando e trocar de assunto na
 * tela.
 */
export function CameraTimeline({
  keyframes,
  onChange,
  duration,
  playhead,
  onSeek,
  active,
  onSelect,
}: Props) {
  const track = useRef<HTMLDivElement>(null);

  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  const atPlayhead = sorted.findIndex((key) => Math.abs(key.t - playhead) < 0.25);

  const addHere = () => {
    // O novo ponto nasce onde a câmera já está, então marcar não mexe no
    // enquadramento: ele vira uma âncora para o próximo movimento.
    const previous = [...sorted].reverse().find((key) => key.t <= playhead) ?? sorted[0];
    const next: CameraKeyframe = {
      t: Number(clamp(playhead, 0, duration).toFixed(2)),
      x: previous?.x ?? 0.5,
      y: previous?.y ?? 0.5,
      hold: true,
    };
    onChange([...sorted.filter((key) => Math.abs(key.t - next.t) >= 0.25), next]);
    onSelect(sorted.filter((key) => key.t < next.t).length);
  };

  const removeAt = (index: number) => {
    if (sorted.length <= 1) return;
    onChange(sorted.filter((_, i) => i !== index));
    onSelect(Math.max(0, index - 1));
  };

  const toggleHold = (index: number) => {
    onChange(sorted.map((key, i) => (i === index ? { ...key, hold: !key.hold } : key)));
  };

  const dragMarker = (event: React.PointerEvent, index: number) => {
    if (index === 0) return; // o primeiro ponto ancora o início do corte
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    onSelect(index);

    const move = (moveEvent: PointerEvent) => {
      const bounds = track.current?.getBoundingClientRect();
      if (!bounds) return;
      const t = clamp(((moveEvent.clientX - bounds.left) / bounds.width) * duration, 0.1, duration);
      onChange(sorted.map((key, i) => (i === index ? { ...key, t: Number(t.toFixed(2)) } : key)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[12px] font-medium">Movimento da câmera</span>
          <span className="num text-[11px] text-faint">
            {sorted.length} posiç{sorted.length === 1 ? "ão" : "ões"}
          </span>
        </div>
        <Button
          variant={atPlayhead === -1 ? "accent" : "outline"}
          size="sm"
          onClick={atPlayhead === -1 ? addHere : () => onSelect(atPlayhead)}
        >
          <Plus className="size-3.5" strokeWidth={2.4} />
          {atPlayhead === -1 ? "Marcar posição aqui" : "Já há uma marca aqui"}
        </Button>
      </div>

      <div
        ref={track}
        className="relative h-12 cursor-pointer rounded-2xl border border-line bg-surface-2"
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          onSeek(clamp(((event.clientX - bounds.left) / bounds.width) * duration, 0, duration));
        }}
      >
        {/* Trechos: cheio = a câmera desliza, tracejado = fica parada. */}
        {sorted.slice(0, -1).map((key, index) => {
          const next = sorted[index + 1];
          return (
            <div
              key={`span-${index}`}
              className={cn(
                "absolute top-1/2 h-0.5 -translate-y-1/2",
                next.hold ? "bg-line-strong" : "bg-accent/60",
              )}
              style={{
                left: `${(key.t / Math.max(duration, 0.1)) * 100}%`,
                width: `${((next.t - key.t) / Math.max(duration, 0.1)) * 100}%`,
              }}
            />
          );
        })}

        {/* Cabeça de leitura. */}
        <div
          className="pointer-events-none absolute inset-y-1 w-px bg-ink"
          style={{ left: `${(playhead / Math.max(duration, 0.1)) * 100}%` }}
        />

        {sorted.map((key, index) => (
          <button
            key={`${index}-${key.t}`}
            title={`${clock(key.t)} · ${key.hold ? "corte seco" : "movimento suave"}`}
            onPointerDown={(event) => dragMarker(event, index)}
            onClick={(event) => {
              event.stopPropagation();
              onSelect(index);
              onSeek(key.t);
            }}
            className={cn(
              "absolute top-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-2 transition-transform",
              index === active
                ? "scale-110 border-accent bg-accent text-accent-ink"
                : "border-line-strong bg-surface text-muted hover:border-faint",
              index > 0 && "cursor-grab active:cursor-grabbing",
            )}
            style={{ left: `${(key.t / Math.max(duration, 0.1)) * 100}%` }}
          >
            {key.hold ? (
              <Scissors className="size-3" strokeWidth={2.2} />
            ) : (
              <MoveRight className="size-3" strokeWidth={2.2} />
            )}
          </button>
        ))}
      </div>

      {sorted[active] && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface-2 px-3 py-2">
          <span className="num text-[12px] font-medium">{clock(sorted[active].t)}</span>
          <span className="text-[11px] text-faint">
            arraste o retângulo no vídeo para mover esta posição
          </span>

          <div className="ml-auto flex items-center gap-1.5">
            {active > 0 && (
              <Button variant="outline" size="sm" onClick={() => toggleHold(active)}>
                {sorted[active].hold ? (
                  <Scissors className="size-3.5" strokeWidth={2} />
                ) : (
                  <MoveRight className="size-3.5" strokeWidth={2} />
                )}
                {sorted[active].hold ? "Corte seco" : "Movimento suave"}
              </Button>
            )}
            {sorted.length > 1 && active > 0 && (
              <Button
                variant="danger"
                size="iconSm"
                aria-label="Remover esta posição"
                onClick={() => removeAt(active)}
              >
                <Trash2 className="size-3.5" strokeWidth={2} />
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
