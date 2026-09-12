import { useRef, useState } from "react";
import { Link2, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { api } from "@/lib/api";
import { useWorkspace } from "@/store/workspace";

/**
 * A porta de entrada: um link (ou arquivo) vira um projeto.
 *
 * Aqui não há nada sobre legenda, formato ou enquadramento de propósito —
 * essas decisões dependem do corte e são tomadas depois, dentro do projeto,
 * quando dá para ver o trecho. Este job só analisa; não renderiza arquivo.
 */
export function SourceForm({ disabled }: { disabled?: boolean }) {
  const { startJob, refreshProjects } = useWorkspace();
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
      startJob(
        await api.createJob({
          source: source.trim(),
          min_clips: minClips,
          // A pipeline só analisa: cada corte é configurado e gerado no editor.
          dry_run: true,
        }),
      );
      setSource("");
      refreshProjects();
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
      startJob(await api.uploadVideo(file, minClips));
      refreshProjects();
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const locked = Boolean(disabled) || busy;

  return (
    <form
      onSubmit={submit}
      className="hairline rounded-4xl border border-line bg-surface p-5 sm:p-7"
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative flex-1">
          <Link2
            className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-faint"
            strokeWidth={1.9}
          />
          <input
            id="source"
            aria-label="Link do vídeo ou caminho local"
            className="h-12 w-full rounded-full border border-line bg-surface-2 pr-4 pl-11 text-[14px] text-ink placeholder:text-faint focus:border-accent focus:outline-none disabled:opacity-50"
            placeholder="Cole o link do YouTube, Twitch ou um caminho local…"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            disabled={locked}
          />
        </div>

        <Button type="submit" variant="accent" size="lg" disabled={locked || !source.trim()}>
          <Sparkles className="size-4" strokeWidth={2.2} />
          {busy ? "Enviando…" : "Encontrar momentos"}
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
        <label className="flex items-center gap-2.5 text-[13px] text-muted" htmlFor="min-clips">
          Quantos momentos
          <input
            id="min-clips"
            type="number"
            min={1}
            max={30}
            className="num h-9 w-16 rounded-full border border-line bg-surface-2 px-3 text-center text-[13px] text-ink focus:border-accent focus:outline-none disabled:opacity-50"
            value={minClips}
            onChange={(event) => setMinClips(Number(event.target.value))}
            disabled={locked}
          />
        </label>

        <Button
          type="button"
          variant="outline"
          onClick={() => fileInput.current?.click()}
          disabled={locked}
          className="ml-auto"
        >
          <Upload className="size-4" strokeWidth={1.9} />
          Enviar arquivo
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept="video/mp4,video/x-matroska,video/*"
          className="hidden"
          onChange={upload}
        />
      </div>

      <p className="mt-4 text-[12px] leading-relaxed text-faint">
        Cada vídeo vira um projeto. A análise encontra os melhores trechos; legenda, formato e
        reposicionamento você escolhe depois, corte a corte, dentro do projeto.
      </p>

      {error && <p className="mt-3 text-[13px] text-rose">{error}</p>}
    </form>
  );
}
