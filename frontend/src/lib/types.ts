/** Contratos espelhando os schemas Pydantic do backend. */

export type JobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface ClipCandidate {
  id: string;
  start_time: number;
  end_time: number;
  duration: number;
  title: string;
  virality_score: number;
  final_score: number;
  audio_score: number;
  summary: string;
  hook: string;
  reason: string;
  tags: string[];
  transcript_text: string;
}

export interface RenderedClip extends ClipCandidate {
  video_path: string;
  subtitle_path: string | null;
  thumbnail_path: string | null;
  width: number;
  height: number;
  reframe_mode: string;
  /** Preenchido pelo endpoint /api/clips, para o player. */
  media_url?: string;
  thumbnail_url?: string | null;
  source_title?: string;
  created_at?: number;
}

export interface Job {
  id: string;
  source: string;
  status: JobStatus;
  progress: number;
  stage: string;
  message: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  error: string | null;
  clips: RenderedClip[];
  candidates: ClipCandidate[];
  result: unknown | null;
}

export interface Health {
  status: "ok" | "degraded";
  version: string;
  ffmpeg: boolean;
  nvenc: boolean;
  encoder: string;
  whisper_device: string;
  whisper_model: string;
  llm_provider: string;
  llm_ok: boolean;
  llm_message: string;
  output_dir: string;
}

export interface JobRequest {
  source: string;
  min_clips?: number;
  max_clips?: number;
  language?: string;
  reframe_mode?: "auto" | "single" | "split" | "center";
  burn_subtitles?: boolean;
  dry_run?: boolean;
}

/** Evento recebido pelo WebSocket de progresso. */
export interface ProgressEvent {
  type: "snapshot" | "progress" | "done" | "error";
  job_id?: string;
  stage?: string;
  stage_label?: string;
  progress?: number;
  message?: string;
  status?: JobStatus;
  clip?: RenderedClip;
  candidates?: ClipCandidate[];
  clips?: RenderedClip[];
  error?: string | null;
}
