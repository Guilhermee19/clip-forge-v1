import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronUp, Loader2, TriangleAlert, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/store/workspace";

/**
 * Barra flutuante do job em andamento.
 *
 * Mora no shell, não numa página: a análise continua enquanto você navega
 * entre a home, a biblioteca e os projetos, e o acompanhamento vem junto.
 */
export function JobDock() {
  const { job, log, connected, dismissJob } = useWorkspace();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const done = job?.status === "completed";

  // Quando a análise termina, o log deixa de interessar: fecha sozinho.
  useEffect(() => {
    if (done) setOpen(false);
  }, [done]);

  if (!job) return null;

  const percent = Math.round(job.progress * 100);
  const active = job.status === "running" || job.status === "queued";
  const failed = job.status === "failed";

  const openProject = () => {
    if (job.project_id) navigate(`/projeto/${job.project_id}`);
    dismissJob();
  };

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-3">
      <div
        className={cn(
          "anim-pop w-full max-w-3xl overflow-hidden rounded-3xl border bg-surface shadow-[var(--shadow-pop)]",
          failed ? "border-rose/40" : done ? "border-accent/40" : "border-line-strong",
        )}
      >
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-2">
            {active ? (
              <Loader2 className="size-4 animate-spin text-accent" strokeWidth={2} />
            ) : failed ? (
              <TriangleAlert className="size-4 text-rose" strokeWidth={2} />
            ) : (
              <span className="num text-[12px] font-bold text-accent">{job.candidates.length}</span>
            )}
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">
              {failed
                ? "A análise falhou"
                : done
                  ? `${job.candidates.length} momento${job.candidates.length === 1 ? "" : "s"} encontrado${job.candidates.length === 1 ? "" : "s"}`
                  : job.stage || "Preparando…"}
            </p>
            <p className="truncate text-[12px] text-faint" title={job.error ?? job.source}>
              {job.error ?? job.message ?? job.source}
            </p>
          </div>

          {active && (
            <span className="num hidden shrink-0 text-[13px] text-muted sm:block">{percent}%</span>
          )}

          {done && job.project_id && (
            <Button variant="accent" size="sm" onClick={openProject}>
              Abrir projeto
            </Button>
          )}

          {active && (
            <Button variant="outline" size="sm" onClick={() => api.cancelJob(job.id)}>
              Cancelar
            </Button>
          )}

          {log.length > 0 && (
            <Button
              variant="ghost"
              size="iconSm"
              aria-label={open ? "Ocultar log" : "Ver log"}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
            </Button>
          )}

          {!active && (
            <Button variant="ghost" size="iconSm" aria-label="Dispensar" onClick={dismissJob}>
              <X className="size-4" />
            </Button>
          )}
        </div>

        <div className="h-1 bg-surface-2">
          <div
            className={cn(
              "h-full transition-[width] duration-500 ease-out",
              failed ? "bg-rose" : "bg-accent",
            )}
            style={{ width: `${failed ? 100 : percent}%` }}
          />
        </div>

        {open && (
          <ol className="scroll-thin max-h-52 space-y-1 overflow-y-auto border-t border-line px-4 py-3 font-mono text-[11px] text-faint">
            {!connected && active && <li className="text-amber">reconectando…</li>}
            {log.map((line, index) => (
              <li key={`${index}-${line}`} className={index === 0 ? "text-ink" : undefined}>
                {line}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
