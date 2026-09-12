import { useMemo, useState } from "react";
import { Library, Search } from "lucide-react";
import { ClipGrid } from "@/components/ClipGrid";
import { PageHeader } from "@/components/layout/PageHeader";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { useWorkspace } from "@/store/workspace";

/** Todos os cortes renderizados, de todos os projetos, em um lugar só. */
export function LibraryPage() {
  const { library, projects } = useWorkspace();
  const [project, setProject] = useState<string>("todos");
  const [query, setQuery] = useState("");

  // Só os projetos que realmente têm corte viram filtro.
  const withClips = useMemo(
    () => projects.filter((item) => item.clip_count > 0),
    [projects],
  );

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return library.filter((clip) => {
      const byProject = project === "todos" || clip.project_id === project;
      const byTerm =
        !term ||
        clip.title.toLowerCase().includes(term) ||
        clip.tags?.some((tag) => tag.toLowerCase().includes(term));
      return byProject && byTerm;
    });
  }, [library, project, query]);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Biblioteca"
        subtitle={`${library.length} corte${library.length === 1 ? "" : "s"} renderizado${
          library.length === 1 ? "" : "s"
        } em ${withClips.length} projeto${withClips.length === 1 ? "" : "s"}`}
        actions={
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-faint"
              strokeWidth={1.9}
            />
            <input
              aria-label="Buscar corte"
              placeholder="Buscar por título ou tag…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 w-56 rounded-full border border-line bg-surface-2 pr-4 pl-9 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
          </div>
        }
      />

      {withClips.length > 1 && (
        <div className="scroll-thin flex items-center gap-2 overflow-x-auto px-1 pb-1">
          <Chip active={project === "todos"} onClick={() => setProject("todos")}>
            Todos
          </Chip>
          {withClips.map((item) => (
            <Chip
              key={item.id}
              active={project === item.id}
              onClick={() => setProject(item.id)}
              className="max-w-52"
            >
              <span className="truncate">{item.title}</span>
              <span className="num text-[11px] opacity-70">{item.clip_count}</span>
            </Chip>
          ))}
        </div>
      )}

      {visible.length === 0 ? (
        <EmptyState
          icon={Library}
          title={library.length === 0 ? "Biblioteca vazia" : "Nada com esse filtro"}
          description={
            library.length === 0
              ? "Os cortes que você gerar dentro de um projeto aparecem aqui, prontos para baixar."
              : "Tente outro termo ou volte para “Todos”."
          }
        />
      ) : (
        <ClipGrid clips={visible} showProject />
      )}
    </div>
  );
}
