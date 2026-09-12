import { Link } from "react-router-dom";
import { ArrowRight, TriangleAlert } from "lucide-react";
import { useWorkspace } from "@/store/workspace";

/**
 * Aviso curto no topo da home quando falta algo no ambiente.
 *
 * O detalhe e o conserto moram em Ajustes; aqui só o suficiente para a pessoa
 * saber que o resultado vai sair pior (ou nem sair) e para onde ir.
 */
export function EnvironmentAlert() {
  const { health, healthError } = useWorkspace();

  if (healthError) {
    return (
      <Banner tone="rose">
        Backend inacessível. Rode <code className="font-mono">python backend/cli.py serve</code> em
        outro terminal.
      </Banner>
    );
  }

  if (!health) return null;

  const pending = [
    !health.ffmpeg && "FFmpeg",
    health.ffmpeg && !health.nvenc && "h264_nvenc",
    health.whisper_device !== "cuda" && "Whisper na GPU",
    !health.llm_ok && health.llm_provider,
  ].filter(Boolean) as string[];

  if (pending.length === 0) return null;

  return (
    <Banner tone="amber">
      Faltando no ambiente: <span className="font-medium text-ink">{pending.join(", ")}</span>. Dá
      para seguir sem, mas o corte sai mais lento e a seleção, pior.
    </Banner>
  );
}

function Banner({ tone, children }: { tone: "amber" | "rose"; children: React.ReactNode }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-[12px] text-muted ${
        tone === "rose" ? "border-rose/40 bg-rose/5" : "border-amber/30 bg-amber/5"
      }`}
    >
      <TriangleAlert
        className={`size-4 shrink-0 ${tone === "rose" ? "text-rose" : "text-amber"}`}
        strokeWidth={2}
      />
      <p className="min-w-0 flex-1">{children}</p>
      <Link
        to="/ajustes"
        className="inline-flex shrink-0 items-center gap-1.5 font-medium text-ink underline-offset-2 hover:text-accent hover:underline"
      >
        Resolver
        <ArrowRight className="size-3.5" strokeWidth={2} />
      </Link>
    </div>
  );
}
