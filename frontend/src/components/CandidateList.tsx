import { Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { clock, scoreColor, scoreLabel } from "@/lib/format";
import type { ClipCandidate } from "@/lib/types";

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
  return (
    <ol className="divide-y divide-line">
      {candidates.map((candidate, index) => {
        const row = (
          <>
            <span className="num w-5 shrink-0 text-right text-[12px] text-faint">{index + 1}</span>
            <span
              className={cn(
                "num w-9 shrink-0 text-right text-[15px] font-semibold",
                scoreColor(candidate.final_score),
              )}
            >
              {scoreLabel(candidate.final_score)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] text-ink">{candidate.title}</p>
              <p className="num text-[12px] text-faint">
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
                className="group flex w-full cursor-pointer items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-surface-2"
                onClick={() => onEdit(candidate)}
              >
                {row}
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full text-faint transition-colors group-hover:bg-accent group-hover:text-accent-ink">
                  <Pencil className="size-3.5" strokeWidth={2} />
                </span>
              </button>
            ) : (
              <div className="flex items-center gap-3 px-5 py-3">{row}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
