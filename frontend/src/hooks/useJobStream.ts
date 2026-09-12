import { useEffect, useRef, useState } from "react";
import { jobSocketUrl } from "../lib/api";
import type { Job, ProgressEvent, RenderedClip } from "../lib/types";

interface JobStream {
  job: Job | null;
  /** Ultimas linhas de log, da mais recente para a mais antiga. */
  log: string[];
  connected: boolean;
}

const MAX_LOG_LINES = 60;

/**
 * Acompanha um job pelo WebSocket.
 *
 * O backend envia um snapshot do estado atual assim que a conexao abre, entao
 * recarregar a pagina no meio do processamento nao perde nada. Se a conexao
 * cair antes de o job terminar, tentamos reconectar com backoff.
 */
export function useJobStream(jobId: string | null): JobStream {
  const [job, setJob] = useState<Job | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const retryRef = useRef(0);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      setLog([]);
      return;
    }

    let socket: WebSocket | null = null;
    let retryTimer: number | undefined;
    let closedByUs = false;

    const connect = () => {
      socket = new WebSocket(jobSocketUrl(jobId));

      socket.onopen = () => {
        setConnected(true);
        retryRef.current = 0;
      };

      socket.onmessage = (raw) => {
        const event: ProgressEvent = JSON.parse(raw.data);

        if (event.message) {
          setLog((previous) => [event.message!, ...previous].slice(0, MAX_LOG_LINES));
        }

        setJob((previous) => {
          const base: Job =
            previous ??
            ({
              id: jobId,
              source: "",
              status: "running",
              progress: 0,
              stage: "",
              message: "",
              created_at: Date.now() / 1000,
              started_at: null,
              finished_at: null,
              error: null,
              clips: [],
              candidates: [],
              result: null,
              media: null,
              project_id: null,
              has_source: false,
            } as Job);

          const clips: RenderedClip[] = event.clip
            ? [...base.clips, event.clip]
            : (event.clips ?? base.clips);

          return {
            ...base,
            status: event.status ?? base.status,
            progress: event.progress ?? base.progress,
            stage: event.stage_label ?? event.stage ?? base.stage,
            message: event.message ?? base.message,
            error: event.error ?? base.error,
            candidates: event.candidates ?? base.candidates,
            media: event.media ?? base.media,
            project_id: event.project_id ?? base.project_id,
            has_source: event.has_source ?? base.has_source,
            clips,
          };
        });
      };

      socket.onclose = () => {
        setConnected(false);
        if (closedByUs) return;

        // Backoff simples: 1s, 2s, 4s... ate 10s.
        const delay = Math.min(10_000, 1000 * 2 ** retryRef.current++);
        retryTimer = window.setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      closedByUs = true;
      window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [jobId]);

  return { job, log, connected };
}
