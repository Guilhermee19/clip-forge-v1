import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Check, Film, Pencil, Scissors, Trash2, TriangleAlert } from "lucide-react";
import { CandidateList } from "@/components/CandidateList";
import { ClipEditor } from "@/components/ClipEditor";
import { ClipGrid } from "@/components/ClipGrid";
import { PageHeader } from "@/components/layout/PageHeader";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Stat } from "@/components/ui/Stat";
import { api } from "@/lib/api";
import { clock, since } from "@/lib/format";
import type { ClipCandidate, ProjectDetail, RenderedClip } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

/** A tela de um vídeo: os trechos que a análise achou e os cortes já gerados. */
export function ProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { formats, job, refreshProjects, refreshLibrary } = useWorkspace();

  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClipCandidate | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProject(await api.getProject(id));
      setError(null);
    } catch (exception) {
      setError((exception as Error).message);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  // A análise deste projeto acabou de terminar: recarrega para ver os trechos.
  useEffect(() => {
    if (job?.project_id === id && (job.status === "completed" || job.status === "failed")) {
      load();
    }
  }, [job?.project_id, job?.status, id, load]);

  const afterRender = (clips: RenderedClip[]) => {
    setEditing(null);
    if (clips.length > 0) {
      load();
      refreshLibrary();
      refreshProjects();
    }
  };

  const removeProject = async () => {
    if (!project) return;
    if (!window.confirm(`Excluir "${project.title}" e todos os cortes dele?`)) return;
    await api.deleteProject(project.id);
    refreshProjects();
    refreshLibrary();
    navigate("/");
  };

  const removeClip = async (clip: RenderedClip) => {
    if (!project || !window.confirm(`Excluir o corte "${clip.title}"?`)) return;
    await api.deleteClip(project.id, clip.id);
    load();
    refreshLibrary();
    refreshProjects();
  };

  const saveTitle = async () => {
    if (!project || renaming === null) return;
    const title = renaming.trim();
    setRenaming(null);
    if (!title || title === project.title) return;
    setProject(await api.renameProject(project.id, title));
    refreshProjects();
  };

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader title="Projeto" back />
        <EmptyState
          icon={TriangleAlert}
          title="Projeto não encontrado"
          description={error}
          action={<Button onClick={() => navigate("/")}>Voltar para o início</Button>}
        />
      </div>
    );
  }

  if (!project) {
    return <div className="h-64 animate-pulse rounded-3xl border border-line bg-surface" />;
  }

  const canEdit = project.has_source && Boolean(project.media) && formats.length > 0;
  const analyzing = project.status === "analyzing";

  return (
    <div className="flex flex-col gap-4">
      {renaming === null ? (
        <PageHeader
          title={project.title}
          subtitle={`${project.source_url ?? project.source} · atualizado ${since(project.updated_at)}`}
          back
          actions={
            <>
              <Button
                variant="outline"
                size="icon"
                aria-label="Renomear projeto"
                title="Renomear"
                onClick={() => setRenaming(project.title)}
              >
                <Pencil className="size-4" strokeWidth={1.9} />
              </Button>
              <Button
                variant="danger"
                size="icon"
                aria-label="Excluir projeto"
                title="Excluir projeto"
                onClick={removeProject}
              >
                <Trash2 className="size-4" strokeWidth={1.9} />
              </Button>
            </>
          }
        />
      ) : (
        <div className="flex items-center gap-2 px-1">
          <input
            autoFocus
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") saveTitle();
              if (event.key === "Escape") setRenaming(null);
            }}
            className="h-12 flex-1 rounded-full border border-line bg-surface-2 px-5 text-[20px] font-semibold text-ink focus:border-accent focus:outline-none"
          />
          <Button variant="accent" size="icon" aria-label="Salvar nome" onClick={saveTitle}>
            <Check className="size-4" strokeWidth={2.2} />
          </Button>
        </div>
      )}

      <Panel className="flex flex-wrap items-center gap-6 p-5">
        <Stat label="Duração do vídeo" value={clock(project.media?.duration ?? 0)} />
        <Stat
          label="Trechos encontrados"
          value={project.candidates.length}
          className="border-l border-line pl-6"
        />
        <Stat
          label="Cortes gerados"
          value={project.clips.length}
          className="border-l border-line pl-6"
        />
        {!project.has_source && (
          <p className="ml-auto max-w-xs text-[12px] text-amber">
            O vídeo de origem não está mais no disco: dá para baixar os cortes já gerados, mas não
            criar novos.
          </p>
        )}
      </Panel>

      {project.last_error && (
        <Panel className="border-rose/40 p-4">
          <p className="text-[13px] text-rose">{project.last_error}</p>
        </Panel>
      )}

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Panel>
          <PanelHeader
            title="Trechos encontrados"
            hint={
              canEdit
                ? "Clique em um trecho para ajustar e gerar o corte"
                : analyzing
                  ? "A análise ainda está rodando"
                  : "Sem o vídeo original, não dá para gerar novos cortes"
            }
          />
          {project.candidates.length === 0 ? (
            <p className="px-5 pb-5 text-[13px] text-muted">
              {analyzing
                ? "Assim que a análise terminar, os melhores momentos aparecem aqui."
                : "Nenhum trecho foi selecionado para este vídeo."}
            </p>
          ) : (
            <div className="scroll-thin max-h-[70vh] overflow-y-auto pb-2">
              <CandidateList
                candidates={project.candidates}
                editable={canEdit}
                onEdit={canEdit ? setEditing : undefined}
              />
            </div>
          )}
        </Panel>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline gap-2.5 px-1">
            <h2 className="text-[15px] font-semibold tracking-tight">Cortes gerados</h2>
            <span className="num text-[12px] text-faint">{project.clips.length}</span>
          </div>

          {project.clips.length === 0 ? (
            <EmptyState
              icon={canEdit ? Scissors : Film}
              title="Nenhum corte ainda"
              description={
                canEdit
                  ? "Escolha um trecho ao lado: você ajusta enquadramento, formato e legenda antes de renderizar."
                  : "Este projeto não tem cortes renderizados."
              }
            />
          ) : (
            <ClipGrid clips={project.clips} projectId={project.id} onDelete={removeClip} />
          )}
        </section>
      </div>

      {editing && project.media && (
        <ClipEditor
          projectId={project.id}
          candidate={editing}
          media={project.media}
          formats={formats}
          onRendered={afterRender}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
