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
  /** Formato de saída, presente nos cortes gerados pelo editor. */
  aspect_ratio?: AspectRatio;
  source_title?: string;
  project_id?: string;
  project_title?: string;
  created_at?: number;
}

/** Uma palavra transcrita com timestamps próprios. */
export interface Word {
  text: string;
  start: number;
  end: number;
  probability: number;
}

export type AspectRatio = "9:16" | "4:5" | "1:1" | "16:9";
export type ReframeMode =
  | "auto"
  | "single"
  | "split"
  | "center"
  | "manual"
  | "composite";

/** Uma faixa do layout empilhado, em frações do frame de origem (0-1). */
export interface LayoutRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Fração da altura final ocupada por esta faixa. */
  weight: number;
  label: string;
}

/** O que a análise recomenda para um trecho. */
export interface LayoutSuggestion {
  mode: ReframeMode;
  aspect_ratio: AspectRatio;
  reason: string;
  confidence: number;
  regions: LayoutRegion[];
  faces_detected: number;
}

export interface MediaInfo {
  path: string;
  title: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  has_audio: boolean;
  source_url: string | null;
}

/** Estilo da legenda, ajustável por corte. Cores em `#RRGGBB`. */
export interface SubtitleStyle {
  font_size: number;
  /** Distância até a base do vídeo, em pixels da saída (altura 1920). */
  margin_v: number;
  primary_color: string;
  highlight_color: string;
  max_words: number;
}

/** Ajustes que o editor manda de volta para o backend renderizar. */
export interface RenderRequest {
  start_time: number;
  end_time: number;
  title?: string;
  /** Um arquivo é gerado para cada formato desta lista. */
  aspect_ratios: AspectRatio[];
  reframe_mode: ReframeMode;
  /** 0 = enquadramento na esquerda, 1 = na direita. Só vale no modo manual. */
  manual_offset?: number | null;
  /** Faixas empilhadas, de cima para baixo. Exigido no modo composite. */
  regions?: LayoutRegion[] | null;
  burn_subtitles: boolean;
  subtitle_style?: SubtitleStyle;
}

export interface RenderResponse {
  clips: (RenderedClip & { aspect_ratio: AspectRatio })[];
}

export interface FormatOption {
  value: AspectRatio;
  width: number;
  height: number;
  label: string;
}

export interface FormatsResponse {
  formats: FormatOption[];
  reframe_modes: { value: ReframeMode; label: string }[];
}

/** Um vídeo de origem e tudo que saiu dele. */
export interface ProjectSummary {
  id: string;
  title: string;
  source: string;
  source_url: string | null;
  status: "new" | "analyzing" | "ready" | "failed";
  created_at: number;
  updated_at: number;
  clip_count: number;
  candidate_count: number;
  has_source: boolean;
  duration: number;
  thumbnail_url: string | null;
  last_error: string | null;
}

export interface ProjectDetail extends ProjectSummary {
  media: MediaInfo | null;
  candidates: ClipCandidate[];
  clips: RenderedClip[];
  transcript_path: string | null;
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
  media: MediaInfo | null;
  /** Projeto alimentado por este job; a UI abre ele quando a análise termina. */
  project_id: string | null;
  /** O vídeo de origem ainda está no disco: dá para pré-visualizar e reeditar. */
  has_source: boolean;
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
  type: "snapshot" | "status" | "progress" | "done" | "error";
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
  media?: MediaInfo | null;
  has_source?: boolean;
  transcript_path?: string;
  project_id?: string;
}
