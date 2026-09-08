import { useRef, useState } from "react";
import { api } from "../lib/api";
import type { Job, JobRequest } from "../lib/types";

interface Props {
  onJobCreated: (job: Job) => void;
  disabled: boolean;
}

const REFRAME_OPTIONS: { value: NonNullable<JobRequest["reframe_mode"]>; label: string }[] = [
  { value: "auto", label: "Automático" },
  { value: "single", label: "Seguir o falante" },
  { value: "split", label: "Split-screen" },
  { value: "center", label: "Crop central" },
];

/** Formulário de entrada: link do YouTube/Twitch ou arquivo local. */
export function JobForm({ onJobCreated, disabled }: Props) {
  const [source, setSource] = useState("");
  const [minClips, setMinClips] = useState(3);
  const [reframe, setReframe] = useState<NonNullable<JobRequest["reframe_mode"]>>("auto");
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!source.trim()) return;

    setBusy(true);
    setError(null);
    try {
      const job = await api.createJob({
        source: source.trim(),
        min_clips: minClips,
        reframe_mode: reframe,
        dry_run: dryRun,
      });
      onJobCreated(job);
      setSource("");
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setBusy(true);
    setError(null);
    try {
      onJobCreated(await api.uploadVideo(file, minClips));
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <form onSubmit={submit} className="card space-y-4">
      <div>
        <label className="label" htmlFor="source">
          Link do vídeo ou caminho local
        </label>
        <div className="flex gap-2">
          <input
            id="source"
            className="field"
            placeholder="https://www.youtube.com/watch?v=..."
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={disabled || busy}
          />
          <button type="submit" className="btn-primary shrink-0" disabled={disabled || busy || !source.trim()}>
            {busy ? "Enviando..." : "Gerar cortes"}
          </button>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <div>
          <label className="label" htmlFor="min-clips">
            Mínimo de cortes
          </label>
          <input
            id="min-clips"
            type="number"
            min={1}
            max={30}
            className="field"
            value={minClips}
            onChange={(event) => setMinClips(Number(event.target.value))}
            disabled={disabled || busy}
          />
        </div>

        <div>
          <label className="label" htmlFor="reframe">
            Reenquadramento
          </label>
          <select
            id="reframe"
            className="field"
            value={reframe}
            onChange={(event) => setReframe(event.target.value as typeof reframe)}
            disabled={disabled || busy}
          >
            {REFRAME_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-end justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-ink-600 bg-ink-800 accent-brand-500"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
              disabled={disabled || busy}
            />
            Só analisar
          </label>

          <button
            type="button"
            className="btn-ghost"
            onClick={() => fileInput.current?.click()}
            disabled={disabled || busy}
          >
            Enviar arquivo
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="video/mp4,video/x-matroska,video/*"
            className="hidden"
            onChange={upload}
          />
        </div>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
