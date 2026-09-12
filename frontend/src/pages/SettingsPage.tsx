import { PageHeader } from "@/components/layout/PageHeader";
import { ModelPicker } from "@/components/ModelPicker";
import { SetupChecklist } from "@/components/SetupChecklist";
import { StoragePanel } from "@/components/StoragePanel";
import { Chip } from "@/components/ui/Chip";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { useWorkspace } from "@/store/workspace";

/** Preparação do ambiente e o que o backend sabe gerar com ele. */
export function SettingsPage() {
  const { health, formats, reframeModes } = useWorkspace();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Ajustes"
        subtitle={
          health
            ? `ClipForge v${health.version} · tudo roda na sua máquina`
            : "Preparação do ambiente local"
        }
      />

      <SetupChecklist />

      <ModelPicker />

      <StoragePanel />

      <div className="grid items-start gap-4 lg:grid-cols-3">
        <Panel>
          <PanelHeader title="Em uso agora" hint="O que o backend carregou nesta sessão" />
          <dl className="space-y-2.5 px-5 pb-5 text-[12px]">
            <Line term="Encoder" value={health?.encoder ?? "—"} />
            <Line
              term="Whisper"
              value={health ? `${health.whisper_model} · ${health.whisper_device}` : "—"}
            />
            <Line term="LLM" value={health?.llm_provider ?? "—"} />
            <Line term="Saída" value={health?.output_dir ?? "—"} />
          </dl>
        </Panel>

        <Panel>
          <PanelHeader title="Formatos de saída" hint="Escolhidos por corte, no editor" />
          <div className="flex flex-wrap gap-2 px-5 pb-5">
            {formats.map((format) => (
              <Chip key={format.value}>
                {format.label}
                <span className="num text-[11px] opacity-60">
                  {format.width}×{format.height}
                </span>
              </Chip>
            ))}
            {formats.length === 0 && <p className="text-[13px] text-muted">Backend fora do ar.</p>}
          </div>
        </Panel>

        <Panel>
          <PanelHeader title="Modos de enquadramento" hint="Sugeridos pela análise de cena" />
          <div className="flex flex-wrap gap-2 px-5 pb-5">
            {reframeModes.map((mode) => (
              <Chip key={mode.value}>{mode.label}</Chip>
            ))}
            {reframeModes.length === 0 && (
              <p className="text-[13px] text-muted">Backend fora do ar.</p>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function Line({ term, value }: { term: string; value: string }) {
  return (
    <div className="flex items-baseline gap-3">
      <dt className="w-16 shrink-0 text-faint">{term}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-muted" title={value}>
        {value}
      </dd>
    </div>
  );
}
