import { clock } from "../lib/format";
import type { ProjectSummary } from "../lib/types";

interface Props {
  projects: ProjectSummary[];
  onOpen: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

const STATUS: Record<ProjectSummary["status"], { label: string; className: string }> = {
  new: { label: "novo", className: "bg-slate-700 text-slate-200" },
  analyzing: { label: "analisando", className: "bg-brand-600 text-ink-950" },
  ready: { label: "pronto", className: "bg-emerald-700 text-emerald-50" },
  failed: { label: "falhou", className: "bg-red-800 text-red-50" },
};

/** Grade de projetos: um por vídeo de origem. */
export function ProjectList({ projects, onOpen, onDelete }: Props) {
  if (projects.length === 0) {
    return (
      <p className="card text-sm text-slate-500">
        Nenhum projeto ainda. Cole um link acima para criar o primeiro.
      </p>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => {
        const status = STATUS[project.status] ?? STATUS.new;
        return (
          <article
            key={project.id}
            className="card group flex flex-col gap-3 p-4 transition-colors hover:border-ink-600"
          >
            <button
              className="flex flex-1 flex-col gap-3 text-left"
              onClick={() => onOpen(project)}
            >
              <div className="relative aspect-video overflow-hidden rounded-lg bg-ink-950">
                {project.thumbnail_url ? (
                  <img
                    src={project.thumbnail_url}
                    alt=""
                    className="h-full w-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-xs text-slate-600">
                    sem cortes ainda
                  </div>
                )}
                <span
                  className={`absolute left-2 top-2 rounded px-2 py-0.5 text-[11px] font-semibold uppercase ${status.className}`}
                >
                  {status.label}
                </span>
                {project.duration > 0 && (
                  <span className="absolute bottom-2 right-2 rounded bg-ink-950/85 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                    {clock(project.duration)}
                  </span>
                )}
              </div>

              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-slate-100" title={project.title}>
                  {project.title}
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {project.clip_count} corte{project.clip_count === 1 ? "" : "s"} ·{" "}
                  {project.candidate_count} trecho{project.candidate_count === 1 ? "" : "s"}
                  {!project.has_source && " · sem o vídeo original"}
                </p>
              </div>
            </button>

            {project.last_error && (
              <p className="truncate text-xs text-red-400" title={project.last_error}>
                {project.last_error}
              </p>
            )}

            <div className="flex items-center justify-between border-t border-ink-700 pt-2">
              <span className="font-mono text-[11px] text-slate-600">{project.id}</span>
              <button
                className="text-xs text-slate-500 opacity-0 transition-opacity hover:text-red-400 focus:opacity-100 group-hover:opacity-100"
                onClick={() => onDelete(project)}
              >
                Excluir
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}
