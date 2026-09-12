import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { SetupTask } from "@/lib/types";

/** Quanto tempo entre duas leituras do log de uma tarefa em andamento. */
const POLL_MS = 1200;

/**
 * Acompanha uma instalação ou download até o fim.
 *
 * Instalar um requisito e baixar um modelo são o mesmo mecanismo no backend —
 * uma tarefa com log —, então a interface acompanha os dois por aqui.
 */
export function useSetupTask(onFinished?: () => void) {
  const [task, setTask] = useState<SetupTask | null>(null);
  const [error, setError] = useState<string | null>(null);

  // O callback muda a cada render de quem chama; guardá-lo numa ref evita
  // recriar o intervalo de polling a cada um desses renders.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const start = useCallback(async (run: () => Promise<SetupTask>) => {
    setError(null);
    try {
      setTask(await run());
    } catch (exception) {
      setError((exception as Error).message);
    }
  }, []);

  const clear = useCallback(() => {
    setTask(null);
    setError(null);
  }, []);

  const taskId = task?.status === "running" ? task.id : null;

  useEffect(() => {
    if (!taskId) return;

    const timer = window.setInterval(async () => {
      try {
        const next = await api.setupTask(taskId);
        setTask(next);
        if (next.status !== "running") finished.current?.();
      } catch (exception) {
        setError((exception as Error).message);
      }
    }, POLL_MS);

    return () => window.clearInterval(timer);
  }, [taskId]);

  return { task, error, start, clear, running: Boolean(taskId) };
}
