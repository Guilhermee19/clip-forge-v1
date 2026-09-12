import { useState } from "react";
import { Link } from "react-router-dom";
import { Download, FileText, Trash2 } from "lucide-react";
import { Tag } from "@/components/ui/Chip";
import { cn } from "@/lib/cn";
import { clock, scoreColor, scoreLabel } from "@/lib/format";
import type { RenderedClip } from "@/lib/types";

interface Props {
  clip: RenderedClip;
  index: number;
  /** Projeto dono do corte, quando o card não vem da biblioteca. */
  projectId?: string;
  /** Mostra de qual projeto o corte saiu (usado na biblioteca). */
  showProject?: boolean;
  onDelete?: (clip: RenderedClip) => void;
}

/** Card de um corte: player vertical, metadados e download. */
export function ClipCard({ clip, index, projectId, showProject, onDelete }: Props) {
  const [expanded, setExpanded] = useState(false);

  const fileName = clip.video_path.split(/[\\/]/).pop() ?? "";
  const owner = clip.project_id ?? projectId;
  const mediaUrl = clip.media_url ?? (owner ? `/media/${owner}/clips/${fileName}` : "");
  const downloadUrl = owner
    ? `/api/projects/${owner}/clips/${encodeURIComponent(fileName)}/download`
    : mediaUrl;

  return (
    <article className="hairline group flex flex-col overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="relative bg-bg">
        <video
          className="mx-auto max-h-[420px] w-full object-contain"
          style={{ aspectRatio: (clip.aspect_ratio ?? "9:16").replace(":", " / ") }}
          src={mediaUrl}
          poster={clip.thumbnail_url ?? undefined}
          controls
          preload="metadata"
        />
        <span className="num absolute top-3 left-3 rounded-full bg-bg/85 px-2 py-0.5 text-[11px] font-semibold">
          #{index + 1}
        </span>
        <span className="num absolute top-3 right-3 rounded-full bg-bg/85 px-2 py-0.5 text-[11px] text-muted">
          {clock(clip.duration)}
        </span>
        {clip.aspect_ratio && (
          <span className="num absolute right-3 bottom-3 rounded-full bg-bg/85 px-2 py-0.5 text-[11px] text-accent">
            {clip.aspect_ratio}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="space-y-1">
          <h3 className="text-[14px] leading-snug font-semibold">{clip.title}</h3>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-faint">
            <span className={cn("num font-semibold", scoreColor(clip.final_score))}>
              {scoreLabel(clip.final_score)} pts
            </span>
            <span className="num">
              {clock(clip.start_time)} → {clock(clip.end_time)}
            </span>
            {showProject && clip.project_id && clip.project_title && (
              <Link
                to={`/projeto/${clip.project_id}`}
                className="truncate text-muted underline-offset-2 hover:text-accent hover:underline"
              >
                {clip.project_title}
              </Link>
            )}
          </div>
        </div>

        {clip.summary && (
          <p className="line-clamp-3 text-[12px] leading-relaxed text-muted">{clip.summary}</p>
        )}

        {clip.tags?.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {clip.tags.slice(0, 5).map((tag) => (
              <li key={tag}>
                <Tag name={tag} />
              </li>
            ))}
          </ul>
        )}

        <div className="mt-auto flex items-center gap-2 pt-1">
          <a
            className="inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-2 rounded-full bg-accent text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent-hover"
            href={downloadUrl}
            download
          >
            <Download className="size-4" strokeWidth={2} />
            Baixar
          </a>

          <button
            className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
            aria-label={expanded ? "Ocultar transcrição" : "Ver transcrição"}
            title="Transcrição"
            onClick={() => setExpanded((value) => !value)}
          >
            <FileText className="size-4" strokeWidth={1.9} />
          </button>

          {onDelete && (
            <button
              className="inline-flex size-9 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-rose/10 hover:text-rose"
              aria-label="Excluir corte"
              title="Excluir corte"
              onClick={() => onDelete(clip)}
            >
              <Trash2 className="size-4" strokeWidth={1.9} />
            </button>
          )}
        </div>

        {expanded && (
          <div className="space-y-2 rounded-2xl bg-bg/60 p-3 text-[12px] leading-relaxed text-muted">
            {clip.reason && (
              <p>
                <span className="font-medium text-ink">Por que viraliza: </span>
                {clip.reason}
              </p>
            )}
            <p className="scroll-thin max-h-40 overflow-y-auto whitespace-pre-wrap">
              {clip.transcript_text}
            </p>
          </div>
        )}
      </div>
    </article>
  );
}
