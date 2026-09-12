import { Link } from "react-router-dom";
import { Film, Trash2 } from "lucide-react";
import { cn } from "@/lib/cn";
import { clock, since } from "@/lib/format";
import type { ProjectSummary } from "@/lib/types";

interface Props {
  projects: ProjectSummary[];
  onDelete?: (project: ProjectSummary) => void;
}

const STATUS: Record<ProjectSummary["status"], { label: string; className: string }> = {
  new: { label: "novo", className: "bg-surface-3 text-muted" },
  analyzing: { label: "analisando", className: "bg-accent text-accent-ink" },
  ready: { label: "pronto", className: "bg-mint/15 text-mint" },
  failed: { label: "falhou", className: "bg-rose/15 text-rose" },
};

/** Grade de projetos: um por vídeo de origem. */
export function ProjectList({ projects, onDelete }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {projects.map((project) => {
        const status = STATUS[project.status] ?? STATUS.new;

        return (
          <article
            key={project.id}
            className="hairline group relative flex flex-col overflow-hidden rounded-3xl border border-line bg-surface transition-colors hover:border-line-strong"
          >
            <Link to={`/projeto/${project.id}`} className="flex flex-1 flex-col">
              <div className="relative aspect-video overflow-hidden bg-bg">
                {project.thumbnail_url ? (
                  <img
                    src={project.thumbnail_url}
                    alt=""
                    className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center">
                    <Film className="size-7 text-line-strong" strokeWidth={1.5} />
                  </div>
                )}

                <span
                  className={cn(
                    "absolute top-3 left-3 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase",
                    status.className,
                  )}
                >
                  {status.label}
                </span>

                {project.duration > 0 && (
                  <span className="num absolute right-3 bottom-3 rounded-full bg-bg/85 px-2 py-0.5 text-[11px] text-ink">
                    {clock(project.duration)}
                  </span>
                )}
              </div>

              <div className="flex flex-1 flex-col gap-1 p-4">
                <h3 className="line-clamp-2 text-[14px] leading-snug font-semibold" title={project.title}>
                  {project.title}
                </h3>

                <p className="mt-auto pt-2 text-[12px] text-faint">
                  <span className="num text-muted">{project.clip_count}</span> corte
                  {project.clip_count === 1 ? "" : "s"} ·{" "}
                  <span className="num text-muted">{project.candidate_count}</span> trecho
                  {project.candidate_count === 1 ? "" : "s"} · {since(project.updated_at)}
                </p>

                {project.last_error && (
                  <p className="truncate text-[12px] text-rose" title={project.last_error}>
                    {project.last_error}
                  </p>
                )}
              </div>
            </Link>

            {onDelete && (
              <button
                aria-label={`Excluir ${project.title}`}
                title="Excluir projeto"
                onClick={() => onDelete(project)}
                className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-full bg-bg/80 text-muted opacity-0 transition hover:text-rose focus-visible:opacity-100 group-hover:opacity-100"
              >
                <Trash2 className="size-4" strokeWidth={1.9} />
              </button>
            )}
          </article>
        );
      })}
    </div>
  );
}
