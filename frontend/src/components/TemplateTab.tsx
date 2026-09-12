import { useState } from "react";
import { Check, Loader2, Save, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { EditTemplate } from "@/lib/types";

interface Props {
  templates: EditTemplate[];
  /** Template cujos ajustes estão em uso agora, se algum. */
  appliedId: string | null;
  busy: boolean;
  error: string | null;
  onApply: (template: EditTemplate) => void;
  onSave: (name: string, isDefault: boolean) => void;
  onOverwrite: (template: EditTemplate) => void;
  onSetDefault: (template: EditTemplate) => void;
  onDelete: (template: EditTemplate) => void;
}

const LAYOUT_LABELS: Record<string, string> = {
  auto: "Automático",
  single: "Seguir o falante",
  split: "Split-screen",
  center: "Centro fixo",
  keyframe: "Câmera manual",
  composite: "2 painéis",
};

const PRESET_LABELS: Record<string, string> = {
  karaoke: "karaokê",
  word: "uma palavra",
  block: "caixa",
  clean: "sem destaque",
};

/**
 * Templates de edição: o mesmo acabamento em todos os cortes.
 *
 * Guarda o que não depende do trecho — enquadramento, divisão da tela, posição
 * das faixas, formatos e legenda. Início, fim e movimento de câmera ficam de
 * fora porque só fazem sentido dentro de um trecho específico.
 */
export function TemplateTab({
  templates,
  appliedId,
  busy,
  error,
  onApply,
  onSave,
  onOverwrite,
  onSetDefault,
  onDelete,
}: Props) {
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);

  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim(), asDefault);
    setName("");
    setAsDefault(false);
  };

  return (
    <>
      <div className="rounded-2xl border border-line bg-surface-2 p-3">
        <p className="text-[11px] leading-relaxed text-muted">
          Um template guarda <span className="text-ink">layout, divisão da tela, posição das
          faixas, formatos e legenda</span> — tudo que não depende do trecho. Início, fim e
          movimento de câmera continuam sendo de cada corte.
        </p>
      </div>

      <Field label="Salvar o ajuste atual">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") save();
          }}
          placeholder="Ex.: Cortes de gameplay"
          className="h-10 w-full rounded-2xl border border-line bg-surface-2 px-3.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />
        <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-muted">
          <input
            type="checkbox"
            className="size-4 rounded accent-(--c-accent)"
            checked={asDefault}
            onChange={(event) => setAsDefault(event.target.checked)}
          />
          Usar como padrão em todo corte novo
        </label>
        <Button
          variant="accent"
          onClick={save}
          disabled={!name.trim() || busy}
          className="mt-2.5 w-full"
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" strokeWidth={2} />
          ) : (
            <Save className="size-4" strokeWidth={2} />
          )}
          Salvar template
        </Button>
      </Field>

      <Field label={`Salvos (${templates.length})`}>
        {templates.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-line px-3 py-6 text-center text-[12px] text-faint">
            Nenhum template ainda. Ajuste o enquadramento e a legenda como quer, dê um nome e
            salve — os próximos cortes saem iguais.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {templates.map((template) => (
              <article
                key={template.id}
                className={cn(
                  "rounded-2xl border p-3 transition-colors",
                  template.id === appliedId
                    ? "border-accent bg-accent/10"
                    : "border-line hover:bg-surface-2",
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 truncate text-[13px] font-medium">
                      {template.name}
                      {template.is_default && (
                        <Star className="size-3 shrink-0 fill-accent text-accent" strokeWidth={2} />
                      )}
                    </p>
                    <p className="truncate text-[11px] text-faint">
                      {LAYOUT_LABELS[template.reframe_mode] ?? template.reframe_mode} ·{" "}
                      {template.aspect_ratios.join(", ")} ·{" "}
                      {template.burn_subtitles
                        ? `legenda ${PRESET_LABELS[template.subtitle_style.preset] ?? ""}`
                        : "sem legenda"}
                    </p>
                  </div>

                  <button
                    onClick={() => onSetDefault(template)}
                    title={template.is_default ? "É o padrão" : "Tornar padrão"}
                    aria-label="Tornar padrão"
                    className={cn(
                      "flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors",
                      template.is_default
                        ? "text-accent"
                        : "text-faint hover:bg-surface-3 hover:text-ink",
                    )}
                  >
                    <Star
                      className={cn("size-3.5", template.is_default && "fill-accent")}
                      strokeWidth={2}
                    />
                  </button>

                  <button
                    onClick={() => onDelete(template)}
                    title="Apagar template"
                    aria-label="Apagar template"
                    className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-faint transition-colors hover:bg-rose/10 hover:text-rose"
                  >
                    <Trash2 className="size-3.5" strokeWidth={2} />
                  </button>
                </div>

                <div className="mt-2.5 flex gap-2">
                  <Button
                    variant={template.id === appliedId ? "solid" : "accent"}
                    size="sm"
                    onClick={() => onApply(template)}
                    disabled={busy}
                    className="flex-1"
                  >
                    {template.id === appliedId ? (
                      <>
                        <Check className="size-3.5" strokeWidth={2.6} />
                        Em uso
                      </>
                    ) : (
                      "Aplicar"
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onOverwrite(template)}
                    disabled={busy}
                    title="Substituir pelo ajuste atual do editor"
                  >
                    Atualizar
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </Field>

      {error && <p className="text-[12px] text-rose">{error}</p>}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}
