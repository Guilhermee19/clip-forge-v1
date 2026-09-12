import { useMemo, useState } from "react";
import { FolderOpen, Search } from "lucide-react";
import { EnvironmentAlert } from "@/components/EnvironmentAlert";
import { PageHeader } from "@/components/layout/PageHeader";
import { ProjectList } from "@/components/ProjectList";
import { SourceForm } from "@/components/SourceForm";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { api } from "@/lib/api";
import type { ProjectSummary } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

type Filter = "todos" | "ready" | "analyzing" | "failed";

const filters: { id: Filter; label: string }[] = [
  { id: "todos", label: "Todos" },
  { id: "ready", label: "Prontos" },
  { id: "analyzing", label: "Analisando" },
  { id: "failed", label: "Com erro" },
];

/**
 * Tela inicial: a única coisa que se faz aqui é apontar um vídeo. Tudo que já
 * foi processado vira um card de projeto logo abaixo — nenhum corte solto.
 */
export function Home() {
  const { projects, refreshProjects, healthError } = useWorkspace();
  const [filter, setFilter] = useState<Filter>("todos");
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return projects.filter((project) => {
      const byStatus = filter === "todos" || project.status === filter;
      const byTerm = !term || project.title.toLowerCase().includes(term);
      return byStatus && byTerm;
    });
  }, [projects, filter, query]);

  const remove = async (project: ProjectSummary) => {
    if (!window.confirm(`Excluir "${project.title}" e todos os cortes dele?`)) return;
    await api.deleteProject(project.id);
    refreshProjects();
  };

  const clips = projects.reduce((total, project) => total + project.clip_count, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Início"
        subtitle="Lives e podcasts viram cortes verticais com legenda animada — tudo local."
      />

      <EnvironmentAlert />

      <SourceForm disabled={Boolean(healthError)} />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <div className="flex items-baseline gap-2.5">
            <h2 className="text-[15px] font-semibold tracking-tight">Seus projetos</h2>
            <span className="num text-[12px] text-faint">
              {projects.length} vídeo{projects.length === 1 ? "" : "s"} · {clips} corte
              {clips === 1 ? "" : "s"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint"
                strokeWidth={1.9}
              />
              <input
                aria-label="Buscar projeto"
                placeholder="Buscar…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-8 w-40 rounded-full border border-line bg-surface-2 pr-3 pl-8 text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </div>

            {filters.map(({ id, label }) => (
              <Chip key={id} active={filter === id} onClick={() => setFilter(id)}>
                {label}
              </Chip>
            ))}
          </div>
        </div>

        {visible.length === 0 ? (
          <EmptyState
            icon={FolderOpen}
            title={projects.length === 0 ? "Nenhum projeto ainda" : "Nada com esse filtro"}
            description={
              projects.length === 0
                ? "Cole um link do YouTube ou envie um arquivo acima. Cada vídeo analisado vira um projeto com os trechos e os cortes gerados a partir dele."
                : "Tente outro termo de busca ou volte para “Todos”."
            }
          />
        ) : (
          <ProjectList projects={visible} onDelete={remove} />
        )}
      </section>
    </div>
  );
}
