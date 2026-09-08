import { clock, scoreColor, scoreLabel } from "../lib/format";
import type { ClipCandidate } from "../lib/types";

interface Props {
  candidates: ClipCandidate[];
}

/**
 * Trechos escolhidos pelo LLM antes da renderização. Aparece assim que a
 * análise termina, então dá para conferir a seleção enquanto o FFmpeg trabalha.
 */
export function CandidateList({ candidates }: Props) {
  if (candidates.length === 0) return null;

  return (
    <section className="card space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
        Trechos selecionados
      </h2>
      <ol className="divide-y divide-ink-700">
        {candidates.map((candidate, index) => (
          <li key={candidate.id} className="flex items-start gap-3 py-2.5">
            <span className="w-5 shrink-0 text-right font-mono text-xs text-slate-600">
              {index + 1}
            </span>
            <span className={`w-10 shrink-0 text-right font-mono text-sm font-semibold ${scoreColor(candidate.final_score)}`}>
              {scoreLabel(candidate.final_score)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-slate-200">{candidate.title}</p>
              <p className="font-mono text-xs text-slate-500">
                {clock(candidate.start_time)} → {clock(candidate.end_time)} ·{" "}
                {Math.round(candidate.duration)}s
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
