import { ClipCard } from "./ClipCard";
import type { RenderedClip } from "../lib/types";

interface Props {
  clips: RenderedClip[];
  title: string;
  emptyMessage?: string;
}

/** Grade responsiva de cortes renderizados. */
export function ClipGrid({ clips, title, emptyMessage }: Props) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">{title}</h2>
        <span className="text-xs text-slate-600">{clips.length}</span>
      </div>

      {clips.length === 0 ? (
        <p className="card text-sm text-slate-500">
          {emptyMessage ?? "Nenhum corte ainda."}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {clips.map((clip, index) => (
            <ClipCard key={clip.id ?? clip.video_path} clip={clip} index={index} />
          ))}
        </div>
      )}
    </section>
  );
}
