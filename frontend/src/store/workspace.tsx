import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";
import { useJobStream } from "@/hooks/useJobStream";
import type {
  FormatOption,
  Health,
  Job,
  ProjectSummary,
  ReframeMode,
  RenderedClip,
} from "@/lib/types";

/**
 * Estado que todas as telas compartilham.
 *
 * O job ativo vive aqui (e não numa página) porque a análise continua rodando
 * enquanto você navega: o dock de progresso fica montado no shell, e voltar
 * para a home no meio do processamento não perde o acompanhamento.
 */
interface Workspace {
  health: Health | null;
  healthError: string | null;
  refreshHealth: () => Promise<void>;

  formats: FormatOption[];
  reframeModes: { value: ReframeMode; label: string }[];

  projects: ProjectSummary[];
  refreshProjects: () => Promise<void>;

  library: RenderedClip[];
  refreshLibrary: () => Promise<void>;

  /** Job em acompanhamento, com log ao vivo. */
  job: Job | null;
  log: string[];
  connected: boolean;
  startJob: (job: Job) => void;
  dismissJob: () => void;
}

const WorkspaceContext = createContext<Workspace | null>(null);

/** Guardado no browser para que um F5 no meio da análise continue de onde parou. */
const JOB_KEY = "clipforge:job";

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [formats, setFormats] = useState<FormatOption[]>([]);
  const [reframeModes, setReframeModes] = useState<{ value: ReframeMode; label: string }[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [library, setLibrary] = useState<RenderedClip[]>([]);
  const [activeJobId, setActiveJobId] = useState<string | null>(() =>
    localStorage.getItem(JOB_KEY),
  );

  const { job, log, connected } = useJobStream(activeJobId);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
      setHealthError(null);
    } catch (exception) {
      setHealthError((exception as Error).message);
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    try {
      setProjects(await api.listProjects());
    } catch {
      // A listagem é secundária: se o backend caiu, o diagnóstico já avisa.
    }
  }, []);

  const refreshLibrary = useCallback(async () => {
    try {
      setLibrary(await api.listClips());
    } catch {
      // idem.
    }
  }, []);

  // Diagnóstico, formatos e conteúdo no primeiro render.
  useEffect(() => {
    refreshHealth();

    api
      .formats()
      .then((data) => {
        setFormats(data.formats);
        setReframeModes(data.reframe_modes);
      })
      .catch(() => setFormats([]));

    refreshProjects();
    refreshLibrary();
  }, [refreshHealth, refreshProjects, refreshLibrary]);

  // Ao terminar (ou falhar) a análise, a lista de projetos já reflete o novo.
  useEffect(() => {
    if (job?.status === "completed" || job?.status === "failed") {
      refreshProjects();
    }
  }, [job?.status, refreshProjects]);

  const startJob = useCallback((created: Job) => {
    localStorage.setItem(JOB_KEY, created.id);
    setActiveJobId(created.id);
  }, []);

  const dismissJob = useCallback(() => {
    localStorage.removeItem(JOB_KEY);
    setActiveJobId(null);
  }, []);

  const value = useMemo<Workspace>(
    () => ({
      health,
      healthError,
      refreshHealth,
      formats,
      reframeModes,
      projects,
      refreshProjects,
      library,
      refreshLibrary,
      job,
      log,
      connected,
      startJob,
      dismissJob,
    }),
    [
      health,
      healthError,
      refreshHealth,
      formats,
      reframeModes,
      projects,
      refreshProjects,
      library,
      refreshLibrary,
      job,
      log,
      connected,
      startJob,
      dismissJob,
    ],
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): Workspace {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("useWorkspace precisa estar dentro de <WorkspaceProvider>.");
  return context;
}
