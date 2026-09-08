import { useCallback, useEffect, useState } from "react";
import { CandidateList } from "./components/CandidateList";
import { ClipGrid } from "./components/ClipGrid";
import { HealthBanner } from "./components/HealthBanner";
import { JobForm } from "./components/JobForm";
import { JobProgress } from "./components/JobProgress";
import { useJobStream } from "./hooks/useJobStream";
import { api } from "./lib/api";
import type { Health, Job, RenderedClip } from "./lib/types";

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [library, setLibrary] = useState<RenderedClip[]>([]);

  const { job, log, connected } = useJobStream(activeJobId);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await api.listClips());
    } catch {
      // A biblioteca é secundária: se o backend caiu, o banner já avisa.
    }
  }, []);

  // Diagnóstico + biblioteca no primeiro render.
  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((exception: Error) => setHealthError(exception.message));

    refreshLibrary();
  }, [refreshLibrary]);

  // Ao terminar um job, recarrega a biblioteca para incluir os novos cortes.
  useEffect(() => {
    if (job?.status === "completed") {
      refreshLibrary();
    }
  }, [job?.status, refreshLibrary]);

  const handleJobCreated = (created: Job) => {
    setActiveJobId(created.id);
  };

  const processing = job?.status === "running" || job?.status === "queued";

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-100">
            Clip<span className="text-brand-500">Forge</span>
          </h1>
          <p className="text-sm text-slate-500">
            Lives e podcasts viram cortes verticais 9:16, com legenda animada — tudo local.
          </p>
        </div>
        {health && (
          <span className="font-mono text-xs text-slate-600">v{health.version}</span>
        )}
      </header>

      <HealthBanner health={health} error={healthError} />

      <JobForm onJobCreated={handleJobCreated} disabled={Boolean(healthError) || processing} />

      {job && <JobProgress job={job} log={log} connected={connected} />}

      {job && job.clips.length === 0 && <CandidateList candidates={job.candidates} />}

      {job && job.clips.length > 0 && (
        <ClipGrid clips={job.clips} title="Cortes deste job" />
      )}

      <ClipGrid
        clips={library}
        title="Biblioteca"
        emptyMessage="Nenhum corte renderizado ainda. Cole um link acima para começar."
      />
    </div>
  );
}
