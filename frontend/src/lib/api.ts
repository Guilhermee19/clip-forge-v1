/** Cliente HTTP do backend. Caminhos relativos passam pelo proxy do Vite. */

import type {
  FormatsResponse,
  Health,
  Job,
  JobRequest,
  LayoutSuggestion,
  OllamaModels,
  ProjectDetail,
  ProjectSummary,
  Requirement,
  RenderedClip,
  RenderRequest,
  RenderResponse,
  SetupTask,
  Storage,
  Word,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });

  if (!response.ok) {
    // O FastAPI devolve `{ detail: ... }` nos erros; usamos isso na UI.
    const body = await response.json().catch(() => null);
    throw new Error(body?.detail ?? `${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<Health>("/api/health"),

  // -------------------------------------------------- preparação do ambiente

  /** O que o ambiente precisa, o que já tem, e como resolver o que falta. */
  requirements: () => request<Requirement[]>("/api/setup/requirements"),

  /** Dispara o plano de instalação de um requisito. */
  install: (requirementId: string) =>
    request<SetupTask>(`/api/setup/install/${requirementId}`, { method: "POST" }),

  /** Estado e log de uma instalação (ou download) em andamento. */
  setupTask: (taskId: string) => request<SetupTask>(`/api/setup/tasks/${taskId}`),

  // ------------------------------------------------------------ armazenamento

  /** O que está em cache, do item mais pesado para o mais leve. */
  storage: () => request<Storage>("/api/storage"),

  /** Apaga um item do cache. A transcrição só sai se pedida. */
  deleteCacheEntry: (key: string, dropTranscript = false) =>
    request<{ removed: string[]; freed_bytes: number }>(
      `/api/storage/cache/${encodeURIComponent(key)}?drop_transcript=${dropTranscript}`,
      { method: "DELETE" },
    ),

  /** Limpeza em lote; por padrão preserva o cache dos projetos existentes. */
  cleanupCache: (options: { keep_in_use: boolean; drop_transcripts: boolean }) =>
    request<{ removed: string[]; freed_bytes: number }>("/api/storage/cleanup", {
      method: "POST",
      body: JSON.stringify(options),
    }),

  /** Modelos recomendados para escolher os cortes, com o estado de cada um. */
  ollamaModels: () => request<OllamaModels>("/api/setup/models"),

  /** Passa a usar outro modelo (grava no .env e na configuração em memória). */
  selectModel: (model: string, numCtx?: number) =>
    request<{ active: string; num_ctx: number }>("/api/setup/models/select", {
      method: "POST",
      body: JSON.stringify({ model, num_ctx: numCtx ?? null }),
    }),

  /** Baixa um modelo do Ollama. */
  pullModel: (model: string) =>
    request<SetupTask>("/api/setup/models/pull", {
      method: "POST",
      body: JSON.stringify({ model }),
    }),

  // ------------------------------------------------------------------- jobs

  listJobs: () => request<Job[]>("/api/jobs"),

  getJob: (id: string) => request<Job>(`/api/jobs/${id}`),

  createJob: (payload: JobRequest) =>
    request<Job>("/api/jobs", {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  cancelJob: (id: string) =>
    request<{ cancelled: string }>(`/api/jobs/${id}`, { method: "DELETE" }),

  listClips: () =>
    request<{ clips: RenderedClip[] }>("/api/clips").then((data) => data.clips),

  formats: () => request<FormatsResponse>("/api/formats"),

  /** Renderiza um corte com os ajustes feitos no editor. */
  renderClip: (projectId: string, payload: RenderRequest) =>
    request<RenderResponse>(`/api/projects/${projectId}/render`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),

  // ---------------------------------------------------------------- projetos

  listProjects: () => request<ProjectSummary[]>("/api/projects"),

  getProject: (id: string) => request<ProjectDetail>(`/api/projects/${id}`),

  renameProject: (id: string, title: string) =>
    request<ProjectDetail>(`/api/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),

  deleteProject: (id: string) =>
    request<{ deleted: string }>(`/api/projects/${id}`, { method: "DELETE" }),

  deleteClip: (projectId: string, clipId: string) =>
    request<{ deleted: string }>(`/api/projects/${projectId}/clips/${clipId}`, {
      method: "DELETE",
    }),

  /** Layout e formato recomendados para um trecho. */
  suggestLayout: (projectId: string, start: number, end: number) =>
    request<LayoutSuggestion>(
      `/api/projects/${projectId}/suggest?start=${start.toFixed(2)}&end=${end.toFixed(2)}`
    ),

  /** Palavras do trecho, para a prévia desenhar a legenda ao vivo. */
  words: (projectId: string, start: number, end: number) =>
    request<{ words: Word[] }>(
      `/api/projects/${projectId}/words?start=${start.toFixed(2)}&end=${end.toFixed(2)}`
    ).then((data) => data.words),

  /** URL do vídeo de origem, usada para a prévia sem renderizar nada. */
  sourceUrl: (projectId: string) => `/api/projects/${projectId}/source`,

  /** Upload de arquivo local: multipart, sem o header JSON. */
  uploadVideo: async (file: File, minClips?: number): Promise<Job> => {
    const form = new FormData();
    form.append("file", file);

    const query = minClips ? `?min_clips=${minClips}` : "";
    const response = await fetch(`/api/jobs/upload${query}`, {
      method: "POST",
      body: form,
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null);
      throw new Error(body?.detail ?? "Falha no upload");
    }
    return response.json();
  },
};

/** URL do WebSocket de progresso de um job. */
export function jobSocketUrl(jobId: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws/jobs/${jobId}`;
}
