/** Cliente HTTP do backend. Caminhos relativos passam pelo proxy do Vite. */

import type { Health, Job, JobRequest, RenderedClip } from "./types";

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
