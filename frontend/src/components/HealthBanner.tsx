import type { Health } from "../lib/types";

interface Props {
  health: Health | null;
  error: string | null;
}

function Pill({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${ok ? "bg-brand-500" : "bg-amber-500"}`}
        aria-hidden
      />
      <span className="text-xs text-slate-400">
        <span className="font-medium text-slate-300">{label}</span> {detail}
      </span>
    </div>
  );
}

/**
 * Estado do ambiente local. Aparece antes do primeiro job porque quase todo
 * problema de setup (FFmpeg ausente, Ollama fora do ar, CUDA nao detectada)
 * aparece aqui em vez de virar um erro no meio do processamento.
 */
export function HealthBanner({ health, error }: Props) {
  if (error) {
    return (
      <div className="card border-red-900/60 bg-red-950/30">
        <p className="text-sm text-red-300">
          Backend inacessível: {error}
          <span className="mt-1 block text-xs text-red-400/70">
            Rode <code className="font-mono">python backend/cli.py serve</code> em outro terminal.
          </span>
        </p>
      </div>
    );
  }

  if (!health) {
    return <div className="card h-16 animate-pulse bg-ink-800/50" />;
  }

  return (
    <div className="card flex flex-wrap items-center gap-x-6 gap-y-2">
      <Pill ok={health.ffmpeg} label="FFmpeg" detail={health.encoder} />
      <Pill
        ok={health.nvenc}
        label="NVENC"
        detail={health.nvenc ? "aceleração por GPU" : "encode na CPU"}
      />
      <Pill
        ok={health.whisper_device === "cuda"}
        label="Whisper"
        detail={`${health.whisper_model} · ${health.whisper_device}`}
      />
      <Pill ok={health.llm_ok} label={health.llm_provider} detail={health.llm_message} />
    </div>
  );
}
