import { useState } from "react";
import { clock, reframeLabel, scoreColor, scoreLabel } from "../lib/format";
import type { RenderedClip } from "../lib/types";

interface Props {
  clip: RenderedClip;
  index: number;
}

/** Card de um corte: player vertical, metadados e download. */
export function ClipCard({ clip, index }: Props) {
  const [expanded, setExpanded] = useState(false);

  const fileName = clip.video_path.split(/[\/]/).pop() ?? "";
  const mediaUrl = clip.media_url ?? `/media/${fileName}`;

  return (
    <article className="card flex flex-col gap-3 p-4">
      <div className="relative overflow-hidden rounded-lg bg-ink-950">
        <video
          className="mx-auto max-h-[420px] w-full object-contain"
          style={{ aspectRatio: (clip.aspect_ratio ?? "9:16").replace(":", " / ") }}
          src={mediaUrl}
          poster={clip.thumbnail_url ?? undefined}
          controls
          preload="metadata"
        />
        <span className="absolute left-2 top-2 rounded bg-ink-950/80 px-2 py-0.5 text-xs font-semibold text-slate-200">
          #{index + 1}
        </span>
        <span className="absolute right-2 top-2 rounded bg-ink-950/80 px-2 py-0.5 text-xs font-mono text-slate-300">
          {clock(clip.duration)}
        </span>
        {clip.aspect_ratio && (
          <span className="absolute bottom-2 right-2 rounded bg-ink-950/80 px-2 py-0.5 font-mono text-xs text-brand-400">
            {clip.aspect_ratio}
          </span>
        )}
      </div>

      <div className="space-y-1">
        <h3 className="text-sm font-semibold leading-snug text-slate-100">{clip.title}</h3>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
          <span className={`font-semibold ${scoreColor(clip.final_score)}`}>
            {scoreLabel(clip.final_score)} pts
          </span>
          <span>{clock(clip.start_time)} → {clock(clip.end_time)}</span>
          <span>{reframeLabel(clip.reframe_mode)}</span>
        </div>
      </div>

      {clip.summary && <p className="text-xs leading-relaxed text-slate-400">{clip.summary}</p>}

      {clip.tags?.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {clip.tags.map((tag) => (
            <li key={tag} className="rounded bg-ink-800 px-2 py-0.5 text-[11px] text-slate-400">
              #{tag}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-auto flex items-center gap-2 pt-1">
        <a
          className="btn-primary flex-1"
          href={`/api/clips/${encodeURIComponent(fileName)}/download`}
          download
        >
          Baixar
        </a>
        <button className="btn-ghost" onClick={() => setExpanded((value) => !value)}>
          {expanded ? "Ocultar" : "Transcrição"}
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 rounded-lg bg-ink-950/60 p-3 text-xs leading-relaxed text-slate-400">
          {clip.reason && (
            <p>
              <span className="font-medium text-slate-300">Por que viraliza: </span>
              {clip.reason}
            </p>
          )}
          <p className="max-h-40 overflow-y-auto whitespace-pre-wrap">{clip.transcript_text}</p>
        </div>
      )}
    </article>
  );
}
