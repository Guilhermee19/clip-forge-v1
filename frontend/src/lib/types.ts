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
  /** Trecho da análise que originou este corte. */
  candidate_id?: string | null;
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
  | "keyframe"
  | "composite";

/** Onde a câmera aponta num instante do corte. */
export interface CameraKeyframe {
  /** Segundos desde o início do corte. */
  t: number;
  /** Centro do enquadramento, em frações do frame de origem (0-1). */
  x: number;
  y: number;
  /** True corta seco aqui; false desliza desde o ponto anterior. */
  hold: boolean;
}

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

/** Os tipos de legenda oferecidos no editor. */
export type SubtitlePreset = "karaoke" | "word" | "block" | "clean";

/** Estilo da legenda, ajustável por corte. Cores em `#RRGGBB`. */
export interface SubtitleStyle {
  font_size: number;
  preset: SubtitlePreset;
  /** Centro do texto em frações da saída. Quando definido, manda no margin_v. */
  pos_x: number | null;
  pos_y: number | null;
  /** Distância até a base do vídeo, em pixels da saída (altura 1920). */
  margin_v: number;
  primary_color: string;
  highlight_color: string;
  max_words: number;
}

/** Ajustes que o editor manda de volta para o backend renderizar. */
export interface RenderRequest {
  /** Trecho de origem: liga o arquivo gerado à linha da lista. */
  candidate_id?: string | null;
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
  /** Posições da câmera ao longo do corte. Exigido no modo keyframe. */
  camera_keyframes?: CameraKeyframe[] | null;
  /** Fecha o enquadramento: 1 = a maior janela que cabe. Constante no corte. */
  zoom?: number;
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

/** Um item do ambiente no diagnóstico: como está e como consertar. */
export interface Requirement {
  id: string;
  label: string;
  summary: string;
  why: string;
  ok: boolean;
  detail: string;
  tutorial: string[];
  docs_url: string;
  /** Os comandos que o botão de instalar vai rodar, mostrados antes. */
  commands: string[];
  can_install: boolean;
  /** Outro requisito que precisa ser resolvido antes deste. */
  blocked_by: string | null;
  needs_restart: boolean;
}

/** Uma instalação disparada pela interface, com log ao vivo. */
export interface SetupTask {
  id: string;
  requirement_id: string;
  status: "running" | "completed" | "failed";
  log: string[];
  error: string | null;
  started_at: number;
  finished_at: number | null;
  needs_restart: boolean;
}

/** Um modelo do Ollama recomendado para a seleção de cortes. */
export interface OllamaModelOption {
  name: string;
  label: string;
  params: string;
  download_gb: number;
  vram_gb: number;
  context: string;
  tier: "leve" | "equilibrado" | "forte";
  note: string;
  suggested_num_ctx: number;
  /** Modelos de raciocínio pensam antes de responder: mais lentos. */
  thinking: boolean;
  installed: boolean;
  active: boolean;
}

/** Modelo já baixado que não está na lista curada, mas dá para usar. */
export interface OllamaModelExtra {
  name: string;
  size_gb: number;
  active: boolean;
}

export interface OllamaModels {
  active: string;
  num_ctx: number;
  /** False quando o Ollama não respondeu: o catálogo aparece sem marcações. */
  available: boolean;
  models: OllamaModelOption[];
  extras: OllamaModelExtra[];
}

/** Uma fonte em cache e o que ela ocupa no disco. */
export interface CacheEntry {
  key: string;
  title: string;
  source_url: string | null;
  video_bytes: number;
  audio_bytes: number;
  transcript_bytes: number;
  total_bytes: number;
  has_video: boolean;
  has_transcript: boolean;
  modified_at: number;
  /** Projeto que ainda depende deste cache para prévia e re-render. */
  used_by: string | null;
  used_by_title: string | null;
}

export interface Storage {
  entries: CacheEntry[];
  cache_bytes: number;
  /** Quanto daria para liberar sem afetar nenhum projeto existente. */
  reusable_bytes: number;
  uploads_bytes: number;
  projects_bytes: number;
  cache_dir: string;
}
