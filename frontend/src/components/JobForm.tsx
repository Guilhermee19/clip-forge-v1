import { useRef, useState } from "react";
import { api } from "../lib/api";
import type { Job } from "../lib/types";

interface Props {
  onJobCreated: (job: Job) => void;
  disabled: boolean;
}

/**
 * Primeira etapa: encontrar os melhores momentos.
 *
 * Aqui não há nada sobre legenda, formato ou enquadramento de propósito —
 * essas decisões dependem do corte e são tomadas depois, no editor, quando dá
 * para ver o trecho. Este job só analisa; não renderiza nenhum arquivo.
 */
export function JobForm({ onJobCreated, disabled }: Props) {
  const [source, setSource] = useState("");
  const [minClips, setMinClips] = useState(5);
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
        // A pipeline só analisa: cada corte é configurado e gerado no editor.
        dry_run: true,
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
          <button
            type="submit"
            className="btn-primary shrink-0"
            disabled={disabled || busy || !source.trim()}
          >
            {busy ? "Enviando..." : "Encontrar momentos"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="w-36">
          <label className="label" htmlFor="min-clips">
            Quantos momentos
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

      <p className="text-xs text-slate-500">
        A análise encontra os melhores trechos. Legenda, formato e reposicionamento você
        escolhe depois, em cada corte.
      </p>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
