import { clock, scoreColor, scoreLabel } from "../lib/format";
import type { ClipCandidate } from "../lib/types";

interface Props {
  candidates: ClipCandidate[];
  /** Quando presente, cada linha vira um botão que abre o editor. */
  onEdit?: (candidate: ClipCandidate) => void;
  editable?: boolean;
}

/**
 * Trechos escolhidos pelo LLM antes da renderização. Aparece assim que a
 * análise termina, então dá para revisar — e ajustar — cada corte antes de
 * gastar GPU codificando.
 */
export function CandidateList({ candidates, onEdit, editable = false }: Props) {
  if (candidates.length === 0) return null;

  return (
    <section className="card space-y-2">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Trechos selecionados
        </h2>
        {editable && (
          <span className="text-xs text-slate-500">
            clique para pré-visualizar e ajustar
          </span>
        )}
      </div>

      <ol className="divide-y divide-ink-700">
        {candidates.map((candidate, index) => {
          const row = (
            <>
              <span className="w-5 shrink-0 text-right font-mono text-xs text-slate-600">
                {index + 1}
              </span>
              <span
                className={`w-10 shrink-0 text-right font-mono text-sm font-semibold ${scoreColor(
                  candidate.final_score
                )}`}
              >
                {scoreLabel(candidate.final_score)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-slate-200">{candidate.title}</p>
                <p className="font-mono text-xs text-slate-500">
                  {clock(candidate.start_time)} → {clock(candidate.end_time)} ·{" "}
                  {Math.round(candidate.duration)}s
                </p>
              </div>
            </>
          );

          return (
            <li key={candidate.id}>
              {editable && onEdit ? (
                <button
                  className="flex w-full items-start gap-3 py-2.5 text-left transition-colors hover:bg-ink-800/50"
                  onClick={() => onEdit(candidate)}
                >
                  {row}
                  <span className="shrink-0 self-center text-xs text-brand-500">Editar →</span>
                </button>
              ) : (
                <div className="flex items-start gap-3 py-2.5">{row}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
