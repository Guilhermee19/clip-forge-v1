import { useCallback, useEffect, useState } from "react";
import { Brain, Check, Download, Loader2, RotateCw, TriangleAlert, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useSetupTask } from "@/hooks/useSetupTask";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { OllamaModelOption, OllamaModels } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

const TIERS: Record<OllamaModelOption["tier"], string> = {
  leve: "bg-sky/15 text-sky",
  equilibrado: "bg-accent/15 text-accent",
  forte: "bg-violet/15 text-violet",
};

/**
 * A vitrine de modelos do Ollama.
 *
 * A lista é curada para *esta* tarefa: ler a transcrição e devolver os trechos
 * em JSON. O que manda na escolha é caber na VRAM junto do Whisper e não
 * escorregar no schema — não o ranking geral do modelo.
 */
export function ModelPicker() {
  const { refreshHealth } = useWorkspace();
  const [data, setData] = useState<OllamaModels | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api.ollamaModels());
      setError(null);
    } catch (exception) {
      setError((exception as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onFinished = useCallback(() => {
    load();
    refreshHealth();
  }, [load, refreshHealth]);

  const { task, error: taskError, start, running } = useSetupTask(onFinished);

  const pull = (model: string) => start(() => api.pullModel(model));

  const select = async (model: string) => {
    setBusy(model);
    setError(null);
    try {
      await api.selectModel(model);
      await load();
      refreshHealth();
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <Panel className="border-rose/40 p-5">
        <p className="text-[13px] text-rose">Não consegui listar os modelos: {error}</p>
      </Panel>
    );
  }

  if (!data) return <Panel className="h-72 animate-pulse" />;

  const pulling = task?.requirement_id.replace(/^pull:/, "") ?? null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Modelo do Ollama</h2>
          <span className="text-[12px] text-faint">
            quem lê a transcrição e escolhe os cortes
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RotateCw className="size-3.5" strokeWidth={2} />
          Atualizar
        </Button>
      </div>

      {!data.available && (
        <p className="flex items-center gap-2.5 rounded-2xl border border-amber/30 bg-amber/5 px-4 py-3 text-[12px] text-muted">
          <TriangleAlert className="size-4 shrink-0 text-amber" strokeWidth={2} />
          O Ollama não respondeu, então não dá para saber o que já está baixado nem puxar
          nada. Suba o serviço em Requisitos — trocar o modelo em uso continua funcionando.
        </p>
      )}

      <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
        {data.models.map((model) => (
          <ModelCard
            key={model.name}
            model={model}
            numCtx={data.num_ctx}
            busy={busy === model.name}
            pulling={pulling === model.name && running}
            disabled={running || Boolean(busy)}
            canPull={data.available}
            onPull={() => pull(model.name)}
            onSelect={() => select(model.name)}
          />
        ))}
      </div>

      {(task || taskError) && (
        <Panel className="p-4">
          {taskError && <p className="text-[12px] text-rose">{taskError}</p>}
          {task && (
            <>
              <div className="mb-2 flex items-center gap-2 text-[12px]">
                {task.status === "running" && (
                  <>
                    <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={2} />
                    <span className="text-muted">Baixando {pulling}…</span>
                  </>
                )}
                {task.status === "completed" && (
                  <>
                    <Check className="size-3.5 text-accent" strokeWidth={2.6} />
                    <span className="text-muted">{pulling} baixado.</span>
                  </>
                )}
                {task.status === "failed" && (
                  <>
                    <TriangleAlert className="size-3.5 text-rose" strokeWidth={2.2} />
                    <span className="text-rose">{task.error ?? "O download falhou."}</span>
                  </>
                )}
              </div>
              <ol className="scroll-thin max-h-40 overflow-y-auto rounded-xl bg-bg p-3 font-mono text-[11px] text-faint">
                {task.log.slice(-40).map((line, index) => (
                  <li key={`${index}-${line}`}>{line}</li>
                ))}
              </ol>
            </>
          )}
        </Panel>
      )}

      <Panel>
        <PanelHeader
          title="Outro modelo"
          hint="Qualquer tag da biblioteca do Ollama — ex.: mistral-nemo:12b"
        />
        <div className="flex flex-wrap gap-2 px-5 pb-5">
          <input
            aria-label="Nome do modelo"
            placeholder="familia:tag"
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            className="h-10 min-w-56 flex-1 rounded-full border border-line bg-surface-2 px-4 font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <Button
            variant="outline"
            disabled={!custom.trim() || running || !data.available}
            onClick={() => pull(custom.trim())}
          >
            <Download className="size-4" strokeWidth={1.9} />
            Baixar
          </Button>
          <Button
            variant="accent"
            disabled={!custom.trim() || Boolean(busy)}
            onClick={() => select(custom.trim())}
          >
            Usar
          </Button>
        </div>

        {data.extras.length > 0 && (
          <div className="border-t border-line px-5 py-4">
            <p className="mb-2.5 text-[11px] font-medium tracking-wide text-faint uppercase">
              Já baixados, fora da lista
            </p>
            <div className="flex flex-wrap gap-2">
              {data.extras.map((extra) => (
                <Chip
                  key={extra.name}
                  active={extra.active}
                  onClick={extra.active ? undefined : () => select(extra.name)}
                >
                  <span className="font-mono">{extra.name}</span>
                  <span className="num opacity-60">{extra.size_gb} GB</span>
                </Chip>
              ))}
            </div>
          </div>
        )}
      </Panel>

      {error && <p className="px-1 text-[12px] text-rose">{error}</p>}
    </div>
  );
}

function ModelCard({
  model,
  numCtx,
  busy,
  pulling,
  disabled,
  canPull,
  onPull,
  onSelect,
}: {
  model: OllamaModelOption;
  numCtx: number;
  busy: boolean;
  pulling: boolean;
  disabled: boolean;
  canPull: boolean;
  onPull: () => void;
  onSelect: () => void;
}) {
  return (
    <article
      className={cn(
        "hairline flex flex-col gap-3 rounded-3xl border bg-surface p-4 transition-colors",
        model.active ? "border-accent/50" : "border-line",
      )}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[14px] font-semibold">{model.label}</h3>
          <p className="truncate font-mono text-[11px] text-faint">{model.name}</p>
        </div>
        <span
          className={cn(
            "shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold tracking-wide uppercase",
            TIERS[model.tier],
          )}
        >
          {model.tier}
        </span>
      </header>

      <dl className="grid grid-cols-3 gap-2 rounded-2xl bg-surface-2 px-3 py-2.5 text-center">
        <Spec term="download" value={`${model.download_gb} GB`} />
        <Spec term="VRAM" value={`~${model.vram_gb} GB`} />
        <Spec term="contexto" value={model.context} />
      </dl>

      <p className="flex-1 text-[12px] leading-relaxed text-muted">{model.note}</p>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-faint">
        {model.thinking && (
          <span className="inline-flex items-center gap-1">
            <Brain className="size-3.5" strokeWidth={1.9} />
            raciocina antes de responder
          </span>
        )}
        {!model.thinking && (
          <span className="inline-flex items-center gap-1">
            <Zap className="size-3.5" strokeWidth={1.9} />
            resposta direta
          </span>
        )}
      </div>

      <footer className="flex items-center gap-2">
        {model.active ? (
          <span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-[12px] font-medium text-accent-ink">
            <Check className="size-3.5" strokeWidth={2.6} />
            Em uso
          </span>
        ) : model.installed || !canPull ? (
          // Com o Ollama fora do ar não dá para saber o que está baixado, então
          // a escolha fica disponível: ela só grava a configuração.
          <Button
            variant={model.installed ? "accent" : "outline"}
            size="sm"
            onClick={onSelect}
            disabled={busy || disabled}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" strokeWidth={2} /> : null}
            Usar este
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={onPull} disabled={disabled || !canPull}>
            {pulling ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Download className="size-3.5" strokeWidth={2} />
            )}
            {pulling ? "Baixando…" : `Baixar ${model.download_gb} GB`}
          </Button>
        )}

        <span className="num ml-auto text-[11px] text-faint">
          {model.active
            ? `num_ctx ${numCtx}`
            : `usa num_ctx ${model.suggested_num_ctx}`}
        </span>
      </footer>
    </article>
  );
}

function Spec({ term, value }: { term: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[10px] text-faint">{term}</dt>
      <dd className="num truncate text-[12px] font-medium text-ink">{value}</dd>
    </div>
  );
}
