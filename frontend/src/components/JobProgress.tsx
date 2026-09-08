import { api } from "../lib/api";
import type { Job } from "../lib/types";

interface Props {
  job: Job;
  log: string[];
  connected: boolean;
}

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-slate-700 text-slate-200",
  running: "bg-brand-600 text-ink-950",
  completed: "bg-emerald-600 text-ink-950",
  failed: "bg-red-700 text-red-50",
  cancelled: "bg-amber-700 text-amber-50",
};

/** Painel do job em execução: barra de progresso, etapa atual e log ao vivo. */
export function JobProgress({ job, log, connected }: Props) {
  const percent = Math.round(job.progress * 100);
  const active = job.status === "running" || job.status === "queued";

  return (
    <section className="card space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${
                STATUS_STYLES[job.status] ?? "bg-slate-700"
              }`}
            >
              {job.status}
            </span>
            <span className="font-mono text-xs text-slate-500">{job.id}</span>
            {!connected && active && (
              <span className="text-xs text-amber-400">reconectando...</span>
            )}
          </div>
          <p className="mt-1 truncate text-sm text-slate-400" title={job.source}>
            {job.source}
          </p>
        </div>

        {active && (
          <button className="btn-ghost" onClick={() => api.cancelJob(job.id)}>
            Cancelar
          </button>
        )}
      </header>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-sm">
          <span className="text-slate-300">{job.stage || "Aguardando..."}</span>
          <span className="font-mono text-slate-400">{percent}%</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full bg-ink-800"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className={`h-full rounded-full transition-[width] duration-500 ease-out ${
              job.status === "failed" ? "bg-red-600" : "bg-brand-500"
            }`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-2 text-sm text-slate-400">{job.message}</p>
      </div>

      {job.error && (
        <p className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
          {job.error}
        </p>
      )}

      {log.length > 0 && (
        <details className="group" open={active}>
          <summary className="cursor-pointer text-xs uppercase tracking-wide text-slate-500 hover:text-slate-300">
            Log ({log.length})
          </summary>
          <ol className="mt-2 max-h-48 space-y-1 overflow-y-auto font-mono text-xs text-slate-500">
            {log.map((line, index) => (
              <li key={`${index}-${line}`} className={index === 0 ? "text-slate-300" : undefined}>
                {line}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
