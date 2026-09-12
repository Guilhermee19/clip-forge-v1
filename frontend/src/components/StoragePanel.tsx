import { useCallback, useEffect, useState } from "react";
import { FileText, HardDrive, Link2, Loader2, RotateCw, Trash2, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel } from "@/components/ui/Panel";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { bytes, since } from "@/lib/format";
import type { CacheEntry, Storage } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

/**
 * O que o ClipForge guarda em disco, e o botão para liberar espaço.
 *
 * O cache é o que faz reprocessar um vídeo custar segundos em vez de horas,
 * então apagar não é neutro. Duas proteções ficam visíveis aqui: o cache de um
 * projeto existente aparece marcado (e a limpeza em lote pula ele), e a
 * transcrição só sai se você pedir — refazê-la custa muito mais que rebaixar
 * o vídeo.
 */
export function StoragePanel() {
  const { refreshProjects } = useWorkspace();
  const [data, setData] = useState<Storage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [withTranscripts, setWithTranscripts] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.storage());
      setError(null);
    } catch (exception) {
      setError((exception as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const removeEntry = async (entry: CacheEntry) => {
    const keeps =
      entry.has_transcript && !withTranscripts
        ? `\n\nA transcrição (${bytes(entry.transcript_bytes)}) é mantida — refazê-la custa horas.`
        : "";
    const warns = entry.used_by
      ? `\n\nAtenção: o projeto "${entry.used_by_title}" usa este vídeo. Sem ele você perde a prévia e não consegue gerar novos cortes desse projeto.`
      : "";

    if (!window.confirm(`Apagar "${entry.title}" do cache?${keeps}${warns}`)) return;

    setBusy(entry.key);
    setError(null);
    try {
      await api.deleteCacheEntry(entry.key, withTranscripts);
      await Promise.all([load(), refreshProjects()]);
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cleanup = async () => {
    if (!data) return;
    const extra = withTranscripts ? " e as transcrições dele" : " (transcrições mantidas)";
    if (
      !window.confirm(
        `Limpar ${bytes(data.reusable_bytes)} de cache que nenhum projeto usa${extra}?`,
      )
    ) {
      return;
    }

    setBusy("cleanup");
    setError(null);
    try {
      await api.cleanupCache({ keep_in_use: true, drop_transcripts: withTranscripts });
      await load();
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <Panel className="border-rose/40 p-5">
        <p className="text-[13px] text-rose">Não consegui ler o armazenamento: {error}</p>
      </Panel>
    );
  }

  if (!data) return <Panel className="h-64 animate-pulse" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Armazenamento</h2>
          <span className="num text-[12px] text-faint">
            {bytes(data.cache_bytes)} em cache · {bytes(data.projects_bytes)} em cortes
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RotateCw className="size-3.5" strokeWidth={2} />
          Atualizar
        </Button>
      </div>

      <Panel className="flex flex-wrap items-center gap-3 p-4">
        <HardDrive className="size-4 shrink-0 text-faint" strokeWidth={1.9} />
        <p className="min-w-0 flex-1 text-[12px] leading-relaxed text-muted">
          <span className="num font-medium text-ink">{bytes(data.reusable_bytes)}</span> podem sair
          sem afetar nenhum projeto. O cache guarda o vídeo baixado e a transcrição — com eles,
          reprocessar a mesma fonte leva segundos.
        </p>

        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            className="size-4 rounded accent-(--c-accent)"
            checked={withTranscripts}
            onChange={(event) => setWithTranscripts(event.target.checked)}
          />
          Apagar transcrições também
        </label>

        <Button
          variant={data.reusable_bytes > 0 ? "accent" : "outline"}
          size="sm"
          onClick={cleanup}
          disabled={data.reusable_bytes === 0 || busy !== null}
        >
          {busy === "cleanup" ? (
            <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
          ) : (
            <Trash2 className="size-3.5" strokeWidth={2} />
          )}
          Limpar não usados
        </Button>
      </Panel>

      {withTranscripts && (
        <p className="flex items-center gap-2.5 rounded-2xl border border-amber/30 bg-amber/5 px-4 py-3 text-[12px] text-muted">
          <TriangleAlert className="size-4 shrink-0 text-amber" strokeWidth={2} />
          As transcrições vão junto. Baixar de novo leva minutos; transcrever de novo leva horas.
        </p>
      )}

      {data.entries.length === 0 ? (
        <EmptyState
          icon={HardDrive}
          title="Cache vazio"
          description="Os vídeos que você processar ficam guardados aqui para reprocessar rápido."
        />
      ) : (
        <Panel className="divide-y divide-line">
          {data.entries.map((entry) => (
            <article key={entry.key} className="flex items-center gap-3 px-5 py-3.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium" title={entry.title}>
                  {entry.title}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
                  <span className="num">{bytes(entry.video_bytes + entry.audio_bytes)} de vídeo</span>
                  {entry.has_transcript ? (
                    <span className="num inline-flex items-center gap-1 text-muted">
                      <FileText className="size-3" strokeWidth={2} />
                      {bytes(entry.transcript_bytes)} de transcrição
                    </span>
                  ) : (
                    <span className="text-amber">sem transcrição</span>
                  )}
                  <span>{since(entry.modified_at)}</span>
                  {entry.source_url && (
                    <a
                      href={entry.source_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 underline-offset-2 hover:text-accent hover:underline"
                    >
                      <Link2 className="size-3" strokeWidth={2} />
                      origem
                    </a>
                  )}
                </div>
              </div>

              {entry.used_by && (
                <span className="hidden shrink-0 rounded-full bg-accent/15 px-2.5 py-1 text-[10px] font-semibold tracking-wide text-accent uppercase sm:block">
                  em uso
                </span>
              )}

              <span className={cn("num w-20 shrink-0 text-right text-[13px] font-medium")}>
                {bytes(entry.total_bytes)}
              </span>

              <button
                onClick={() => removeEntry(entry)}
                disabled={busy !== null}
                aria-label={`Apagar ${entry.title} do cache`}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-rose/10 hover:text-rose disabled:opacity-40"
              >
                {busy === entry.key ? (
                  <Loader2 className="size-4 animate-spin" strokeWidth={2} />
                ) : (
                  <Trash2 className="size-4" strokeWidth={1.9} />
                )}
              </button>
            </article>
          ))}
        </Panel>
      )}

      {error && <p className="px-1 text-[12px] text-rose">{error}</p>}
    </div>
  );
}
