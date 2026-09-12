import { useMemo } from "react";
import { Check, Pencil } from "lucide-react";
import { cn } from "@/lib/cn";
import { clock, scoreColor, scoreLabel } from "@/lib/format";
import type { ClipCandidate, RenderedClip } from "@/lib/types";

interface Props {
  candidates: ClipCandidate[];
  /** Cortes já gerados no projeto, para marcar as linhas de onde saíram. */
  clips?: RenderedClip[];
  /** Quando presente, cada linha vira um botão que abre o editor. */
  onEdit?: (candidate: ClipCandidate) => void;
  editable?: boolean;
}

/** Tolerância, em segundos, do casamento por tempo com cortes antigos. */
const MATCH_TOLERANCE = 2;

/**
 * Quantos cortes já saíram de cada trecho.
 *
 * Cortes gerados a partir de agora carregam o `candidate_id`. Os anteriores a
 * esse vínculo são casados pelo início do trecho, com folga de alguns segundos
 * porque o editor permite ajustar o corte antes de gerar.
 */
function countByCandidate(
  candidates: ClipCandidate[],
  clips: RenderedClip[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const clip of clips) {
    const matched =
      candidates.find((candidate) => candidate.id === clip.candidate_id) ??
      candidates.find(
        (candidate) => Math.abs(candidate.start_time - clip.start_time) <= MATCH_TOLERANCE,
      );

    if (matched) counts[matched.id] = (counts[matched.id] ?? 0) + 1;
  }

  return counts;
}

/**
 * Trechos escolhidos pelo LLM antes da renderização. Aparece assim que a
 * análise termina, então dá para revisar — e ajustar — cada corte antes de
 * gastar GPU codificando.
 *
 * A ordem é a da nota, do melhor para o pior: o número à esquerda vira a
 * colocação do trecho, e o que vale a pena cortar primeiro fica no topo.
 */
export function CandidateList({ candidates, clips = [], onEdit, editable = false }: Props) {
  const ranked = useMemo(
    () => [...candidates].sort((a, b) => b.final_score - a.final_score),
    [candidates],
  );

  const generated = useMemo(() => countByCandidate(candidates, clips), [candidates, clips]);

  return (
    <ol className="divide-y divide-line">
      {ranked.map((candidate, index) => {
        const count = generated[candidate.id] ?? 0;

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
              <p className={cn("truncate text-[13px]", count > 0 ? "text-muted" : "text-ink")}>
                {candidate.title}
              </p>
              <p className="num text-[12px] text-faint">
                {clock(candidate.start_time)} → {clock(candidate.end_time)} ·{" "}
                {Math.round(candidate.duration)}s
              </p>
            </div>

            {count > 0 && (
              <span
                title={`${count} corte${count === 1 ? "" : "s"} gerado${count === 1 ? "" : "s"} deste trecho`}
                className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-semibold text-accent"
              >
                <Check className="size-3" strokeWidth={2.8} />
                {count > 1 ? count : null}
              </span>
            )}
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
