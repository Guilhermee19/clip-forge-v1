import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  Download,
  ExternalLink,
  Loader2,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Panel } from "@/components/ui/Panel";
import { useSetupTask } from "@/hooks/useSetupTask";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import type { Requirement, SetupTask } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

/**
 * O diagnóstico com conserto embutido.
 *
 * Cada requisito mostra o que é, por que o ClipForge precisa dele e o passo a
 * passo manual. Quando o backend tem um plano para aquela plataforma, o botão
 * roda os comandos e transmite a saída aqui — os comandos vivem fixos no
 * backend, o navegador só escolhe qual requisito.
 */
export function SetupChecklist() {
  const { refreshHealth } = useWorkspace();
  const [requirements, setRequirements] = useState<Requirement[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequirements(await api.requirements());
      setError(null);
    } catch (exception) {
      setError((exception as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Terminada a instalação, o ambiente é reconferido: é a sonda que diz se
  // resolveu de fato, não o código de saída do instalador.
  const onFinished = useCallback(() => {
    load();
    refreshHealth();
  }, [load, refreshHealth]);

  const { task, error: taskError, start } = useSetupTask(onFinished);

  const install = (requirement: Requirement) => {
    setOpen(requirement.id);
    start(() => api.install(requirement.id));
  };

  if (error) {
    return (
      <Panel className="border-rose/40 p-5">
        <p className="text-[13px] text-rose">Não consegui ler o diagnóstico: {error}</p>
        <p className="mt-1 text-[12px] text-muted">
          Rode <code className="font-mono text-ink">python backend/cli.py serve</code> em outro
          terminal.
        </p>
      </Panel>
    );
  }

  if (!requirements) {
    return <Panel className="h-64 animate-pulse" />;
  }

  const pending = requirements.filter((item) => !item.ok).length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Requisitos</h2>
          <span className="text-[12px] text-faint">
            {pending === 0
              ? "tudo pronto"
              : `${pending} item${pending === 1 ? "" : "s"} pendente${pending === 1 ? "" : "s"}`}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={load}>
          <RotateCw className="size-3.5" strokeWidth={2} />
          Verificar de novo
        </Button>
      </div>

      <Panel className="divide-y divide-line">
        {requirements.map((requirement) => (
          <RequirementRow
            key={requirement.id}
            requirement={requirement}
            expanded={open === requirement.id}
            onToggle={() => setOpen((current) => (current === requirement.id ? null : requirement.id))}
            onInstall={() => install(requirement)}
            task={task?.requirement_id === requirement.id ? task : null}
            taskError={task?.requirement_id === requirement.id ? taskError : null}
          />
        ))}
      </Panel>
    </div>
  );
}

function RequirementRow({
  requirement,
  expanded,
  onToggle,
  onInstall,
  task,
  taskError,
}: {
  requirement: Requirement;
  expanded: boolean;
  onToggle: () => void;
  onInstall: () => void;
  task: SetupTask | null;
  taskError: string | null;
}) {
  const logRef = useRef<HTMLOListElement>(null);
  const running = task?.status === "running";

  // O log acompanha o instalador: a linha nova sempre visível.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [task?.log.length]);

  return (
    <div>
      <div className="flex items-center gap-3 px-5 py-4">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full",
            requirement.ok ? "bg-accent text-accent-ink" : "bg-amber/15 text-amber",
          )}
          aria-hidden
        >
          {requirement.ok ? (
            <Check className="size-3.5" strokeWidth={2.6} />
          ) : (
            <TriangleAlert className="size-3.5" strokeWidth={2.2} />
          )}
        </span>

        <button onClick={onToggle} className="min-w-0 flex-1 cursor-pointer text-left">
          <p className="truncate text-[13px] font-medium">
            {requirement.label}
            <span className="ml-2 font-normal text-faint">{requirement.summary}</span>
          </p>
          <p className="truncate text-[12px] text-muted" title={requirement.detail}>
            {requirement.detail}
          </p>
        </button>

        {!requirement.ok && requirement.can_install && (
          <Button variant="accent" size="sm" onClick={onInstall} disabled={running}>
            {running ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2} />
            ) : (
              <Download className="size-3.5" strokeWidth={2} />
            )}
            {running ? "Instalando…" : "Instalar"}
          </Button>
        )}

        {!requirement.ok && requirement.blocked_by && (
          <span className="hidden shrink-0 text-[12px] text-faint sm:block">
            resolva {requirement.blocked_by} antes
          </span>
        )}

        <button
          onClick={onToggle}
          aria-label={expanded ? "Ocultar tutorial" : "Ver tutorial"}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <ChevronDown
            className={cn("size-4 transition-transform", expanded && "rotate-180")}
            strokeWidth={1.9}
          />
        </button>
      </div>

      {expanded && (
        <div className="anim-rise space-y-4 border-t border-line bg-bg/40 px-5 py-4">
          <p className="text-[12px] leading-relaxed text-muted">{requirement.why}</p>

          <div>
            <p className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">
              Passo a passo
            </p>
            <ol className="space-y-1.5">
              {requirement.tutorial.map((step, index) => (
                <li key={index} className="flex gap-2.5 text-[12px] leading-relaxed text-muted">
                  <span className="num shrink-0 text-faint">{index + 1}.</span>
                  <span className="min-w-0 font-mono break-words">{step}</span>
                </li>
              ))}
            </ol>
          </div>

          {requirement.commands.length > 0 && (
            <div>
              <p className="mb-2 text-[11px] font-medium tracking-wide text-faint uppercase">
                O que o botão roda
              </p>
              <ul className="space-y-1">
                {requirement.commands.map((command) => (
                  <li
                    key={command}
                    className="scroll-thin overflow-x-auto rounded-xl bg-surface-2 px-3 py-2 font-mono text-[11px] whitespace-pre text-muted"
                  >
                    {command}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <a
              href={requirement.docs_url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-[12px] text-muted underline-offset-2 hover:text-accent hover:underline"
            >
              Documentação oficial
              <ExternalLink className="size-3.5" strokeWidth={1.9} />
            </a>
            {requirement.needs_restart && (
              <span className="text-[12px] text-faint">
                · depois de instalar, reinicie o backend
              </span>
            )}
          </div>

          {taskError && <p className="text-[12px] text-rose">{taskError}</p>}

          {task && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-[12px]">
                {task.status === "running" && (
                  <>
                    <Loader2 className="size-3.5 animate-spin text-accent" strokeWidth={2} />
                    <span className="text-muted">Rodando…</span>
                  </>
                )}
                {task.status === "completed" && (
                  <>
                    <Check className="size-3.5 text-accent" strokeWidth={2.6} />
                    <span className="text-muted">
                      Plano concluído
                      {task.needs_restart ? " — reinicie o backend para valer" : ""}
                    </span>
                  </>
                )}
                {task.status === "failed" && (
                  <>
                    <TriangleAlert className="size-3.5 text-rose" strokeWidth={2.2} />
                    <span className="text-rose">{task.error ?? "A instalação falhou."}</span>
                  </>
                )}
              </div>

              <ol
                ref={logRef}
                className="scroll-thin max-h-56 overflow-y-auto rounded-xl bg-bg p-3 font-mono text-[11px] leading-relaxed text-faint"
              >
                {task.log.map((line, index) => (
                  <li key={`${index}-${line}`} className={line.startsWith("$") ? "text-ink" : undefined}>
                    {line}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
