import { useCallback, useEffect, useState } from "react";
import { LivePreview } from "./LivePreview";
import { RegionPicker } from "./RegionPicker";
import { api } from "../lib/api";
import { clock } from "../lib/format";
import type {
  AspectRatio,
  ClipCandidate,
  FormatOption,
  LayoutRegion,
  LayoutSuggestion,
  MediaInfo,
  ReframeMode,
  RenderedClip,
  SubtitleStyle,
  Word,
} from "../lib/types";

interface Props {
  jobId: string;
  candidate: ClipCandidate;
  media: MediaInfo;
  formats: FormatOption[];
  onRendered: (clips: RenderedClip[]) => void;
  onClose: () => void;
}

type Tab = "layout" | "captions";

const REFRAME_OPTIONS: { value: ReframeMode; label: string; hint: string }[] = [
  { value: "auto", label: "Automático", hint: "Detecta rostos e decide sozinho" },
  { value: "single", label: "Seguir o falante", hint: "Uma câmera acompanha quem fala" },
  { value: "split", label: "Split-screen", hint: "Duas pessoas empilhadas" },
  { value: "center", label: "Centro fixo", hint: "Sem detecção de rosto" },
  { value: "manual", label: "Posição manual", hint: "Você escolhe onde a câmera fica" },
  {
    value: "composite",
    label: "Gameplay + webcam",
    hint: "Empilha duas áreas da tela; arraste os retângulos no vídeo original",
  },
];

const DEFAULT_REGIONS: LayoutRegion[] = [
  { x: 0.15, y: 0.08, width: 0.7, height: 0.6, weight: 0.62, label: "Conteúdo" },
  { x: 0.62, y: 0.55, width: 0.34, height: 0.4, weight: 0.38, label: "Webcam" },
];

const DEFAULT_STYLE: SubtitleStyle = {
  font_size: 84,
  margin_v: 420,
  primary_color: "#FFFFFF",
  highlight_color: "#FFE500",
  max_words: 4,
};

const PALETTE = ["#FFE500", "#2DD4BF", "#F472B6", "#FB923C", "#A78BFA", "#FFFFFF"];

/**
 * Editor de um corte: original de um lado, resultado ao vivo do outro.
 *
 * O painel da esquerda é o vídeo 16:9 com os controles de enquadramento; o da
 * direita é um canvas que redesenha a composição a cada frame, com a mesma
 * matemática de recorte que o FFmpeg vai usar. Nenhum arquivo é gerado até
 * clicar em salvar, então experimentar é instantâneo.
 */
export function ClipEditor({ jobId, candidate, media, formats, onRendered, onClose }: Props) {
  // Um único estado guarda o elemento: serve de "ref" para os comandos de
  // playback e dispara o render quando o player aparece, para a prévia começar.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const videoRef = { get current() { return videoEl; } };

  const [tab, setTab] = useState<Tab>("layout");
  const [start, setStart] = useState(candidate.start_time);
  const [end, setEnd] = useState(candidate.end_time);
  const [title, setTitle] = useState(candidate.title);
  const [selected, setSelected] = useState<AspectRatio[]>(["9:16"]);
  const [reframe, setReframe] = useState<ReframeMode>("auto");
  const [offset, setOffset] = useState(0.5);
  const [regions, setRegions] = useState<LayoutRegion[]>(DEFAULT_REGIONS);
  const [activeRegion, setActiveRegion] = useState(0);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_STYLE);
  const [words, setWords] = useState<Word[]>([]);
  const [suggestion, setSuggestion] = useState<LayoutSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(candidate.start_time);

  const duration = Math.max(0, end - start);
  const previewAspect = selected[0] ?? "9:16";
  const composing = reframe === "composite";

  const format = formats.find((f) => f.value === previewAspect);
  const targetRatio = format ? format.width / format.height : 9 / 16;
  const cropFraction = Math.min(1, targetRatio / (media.width / media.height));
  const travel = 1 - cropFraction;

  // ------------------------------------------------------------ dados

  const askSuggestion = useCallback(async () => {
    setSuggesting(true);
    setError(null);
    try {
      const result = await api.suggestLayout(jobId, start, end);
      setSuggestion(result);
      setReframe(result.mode);
      setSelected([result.aspect_ratio]);
      if (result.regions.length > 0) setRegions(result.regions);
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setSuggesting(false);
    }
  }, [jobId, start, end]);

  useEffect(() => {
    askSuggestion();
    // Só no mount: reanalisar a cada ajuste custaria uma passada de MediaPipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // As palavras alimentam a legenda desenhada na prévia.
  useEffect(() => {
    api
      .words(jobId, start, end)
      .then(setWords)
      .catch(() => setWords([]));
  }, [jobId, start, end]);

  // ----------------------------------------------------------- player

  const enforceRange = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.currentTime < start - 0.3 || video.currentTime > end) {
      video.currentTime = start;
    }
    setPlayhead(video.currentTime);
  }, [start, end]);

  const seekTo = (time: number) => {
    const video = videoRef.current;
    if (video) video.currentTime = time;
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      if (video.currentTime < start || video.currentTime > end) video.currentTime = start;
      video.play();
    } else {
      video.pause();
    }
  };

  // ------------------------------------------------------------ ações

  const toggleFormat = (value: AspectRatio) => {
    setSelected((previous) => {
      if (!previous.includes(value)) return [...previous, value];
      const rest = previous.filter((v) => v !== value);
      return rest.length > 0 ? rest : previous;
    });
  };

  const applyPreset = (count: 1 | 2) => {
    if (count === 1) {
      setReframe(suggestion?.mode === "composite" ? "center" : suggestion?.mode ?? "auto");
    } else {
      setReframe("composite");
      if (regions.length < 2) setRegions(DEFAULT_REGIONS);
    }
  };

  const submit = async () => {
    setRendering(true);
    setError(null);
    try {
      const response = await api.renderClip(jobId, {
        start_time: Number(start.toFixed(2)),
        end_time: Number(end.toFixed(2)),
        title,
        aspect_ratios: selected,
        reframe_mode: reframe,
        manual_offset: reframe === "manual" ? offset : null,
        regions: composing ? regions : null,
        burn_subtitles: burnSubtitles,
        subtitle_style: style,
      });
      onRendered(response.clips);
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setRendering(false);
    }
  };

  const shift = (setter: (value: number) => void, current: number, delta: number) =>
    setter(Math.max(0, Math.min(media.duration, current + delta)));

  // ------------------------------------------------------------- view

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/95 p-4 backdrop-blur-sm">
      <div className="my-4 w-full max-w-6xl space-y-4 rounded-xl border border-ink-700 bg-ink-900 p-5">
        {/* --------------------------------------------------- abas */}
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-ink-700 pb-3">
          <nav className="flex gap-1">
            {(
              [
                ["layout", "Layout e formato"],
                ["captions", "Legendas"],
              ] as [Tab, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                  tab === value
                    ? "bg-ink-800 text-brand-400"
                    : "text-slate-400 hover:bg-ink-800/50 hover:text-slate-200"
                }`}
              >
                {label}
              </button>
            ))}
          </nav>
          <input
            className="field max-w-sm flex-1 text-sm font-semibold"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Título do corte"
          />
        </header>

        {/* -------------------------------------- original + resultado */}
        <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Original {media.width}×{media.height}
            </p>
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video
                ref={setVideoEl}
                className="w-full"
                src={api.sourceUrl(jobId)}
                muted
                playsInline
                onTimeUpdate={enforceRange}
                onLoadedMetadata={() => seekTo(start)}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />

              {composing ? (
                <RegionPicker
                  regions={regions}
                  onChange={setRegions}
                  active={activeRegion}
                  onSelect={setActiveRegion}
                />
              ) : (
                <div className="pointer-events-none absolute inset-0">
                  <div
                    className="absolute inset-y-0 left-0 bg-ink-950/70"
                    style={{ width: `${cropLeft(reframe, offset, travel) * 100}%` }}
                  />
                  <div
                    className="absolute inset-y-0 right-0 bg-ink-950/70"
                    style={{
                      width: `${(1 - cropLeft(reframe, offset, travel) - cropFraction) * 100}%`,
                    }}
                  />
                  <div
                    className="absolute inset-y-0 border-2 border-brand-500/80"
                    style={{
                      left: `${cropLeft(reframe, offset, travel) * 100}%`,
                      width: `${cropFraction * 100}%`,
                    }}
                  />
                </div>
              )}
            </div>

            {composing && (
              <p className="text-xs text-slate-500">
                Arraste os retângulos e use a alça do canto para redimensionar. A{" "}
                <span className="text-brand-400">faixa 1</span> fica em cima,{" "}
                <span className="text-amber-400">a 2</span> embaixo.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
              Resultado {previewAspect}
            </p>
            <LivePreview
              video={videoEl}
              aspect={previewAspect}
              mode={reframe}
              regions={regions}
              manualOffset={offset}
              sourceWidth={media.width}
              sourceHeight={media.height}
              words={words}
              subtitles={burnSubtitles}
              style={style}
              clipStart={start}
            />
          </div>
        </div>

        {/* ---------------------------------------------- transporte */}
        <div className="flex items-center gap-3 rounded-lg border border-ink-700 bg-ink-800/40 px-3 py-2">
          <button
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-ink-600 text-slate-200 hover:bg-ink-800"
            onClick={togglePlay}
            aria-label={playing ? "Pausar" : "Reproduzir"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
          <input
            type="range"
            min={start}
            max={end}
            step={0.05}
            value={Math.min(Math.max(playhead, start), end)}
            onChange={(event) => seekTo(Number(event.target.value))}
            className="flex-1 accent-brand-500"
          />
          <span className="w-24 shrink-0 text-right font-mono text-xs text-slate-400">
            {clock(playhead - start)} / {clock(duration)}
          </span>
        </div>

        {/* ------------------------------------------------ controles */}
        {tab === "layout" ? (
          <div className="grid gap-5 md:grid-cols-3">
            {/* trim */}
            <div className="space-y-3">
              <TimeControl
                label="Início"
                value={start}
                max={media.duration}
                onChange={(value) => {
                  const next = Math.min(value, end - 1);
                  setStart(next);
                  seekTo(next);
                }}
                onNudge={(delta) =>
                  shift(
                    (v) => {
                      setStart(v);
                      seekTo(v);
                    },
                    start,
                    delta
                  )
                }
              />
              <TimeControl
                label="Fim"
                value={end}
                max={media.duration}
                onChange={(value) => setEnd(Math.max(value, start + 1))}
                onNudge={(delta) => shift(setEnd, end, delta)}
              />
              <p className="text-xs text-slate-500">
                Duração{" "}
                <span className={duration < 5 || duration > 180 ? "text-amber-400" : "text-slate-200"}>
                  {duration.toFixed(1)}s
                </span>
              </p>
            </div>

            {/* formatos */}
            <div className="space-y-2">
              <span className="label">Formatos a gerar</span>
              <div className="grid grid-cols-2 gap-2">
                {formats.map((option) => {
                  const on = selected.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      onClick={() => toggleFormat(option.value)}
                      className={`relative rounded-lg border px-3 py-2 text-left text-xs transition-colors ${
                        on
                          ? "border-brand-500 bg-brand-600/10 text-brand-400"
                          : "border-ink-600 text-slate-400 hover:bg-ink-800"
                      }`}
                    >
                      <span className="block font-semibold">{option.value}</span>
                      <span className="block text-[11px] opacity-70">
                        {option.width}×{option.height}
                      </span>
                      {suggestion?.aspect_ratio === option.value && (
                        <span className="absolute right-1.5 top-1.5 text-[10px] text-brand-500">★</span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-xs text-slate-500">
                O primeiro marcado é o mostrado na prévia.
              </p>
            </div>

            {/* enquadramento */}
            <div className="space-y-3">
              <div>
                <span className="label">Layout</span>
                <div className="mb-2 flex gap-2">
                  <button
                    onClick={() => applyPreset(1)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${
                      composing
                        ? "border-ink-600 text-slate-400 hover:bg-ink-800"
                        : "border-brand-500 bg-brand-600/10 text-brand-400"
                    }`}
                  >
                    1 painel
                  </button>
                  <button
                    onClick={() => applyPreset(2)}
                    className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${
                      composing
                        ? "border-brand-500 bg-brand-600/10 text-brand-400"
                        : "border-ink-600 text-slate-400 hover:bg-ink-800"
                    }`}
                  >
                    2 painéis
                  </button>
                </div>
                <select
                  className="field"
                  value={reframe}
                  onChange={(event) => setReframe(event.target.value as ReframeMode)}
                >
                  {REFRAME_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-slate-500">
                  {REFRAME_OPTIONS.find((o) => o.value === reframe)?.hint}
                </p>
              </div>

              {reframe === "manual" && travel > 0.001 && (
                <Slider
                  label="Posição horizontal"
                  value={offset}
                  min={0}
                  max={1}
                  step={0.01}
                  onChange={setOffset}
                  legend={["esquerda", "centro", "direita"]}
                />
              )}

              {composing && (
                <Slider
                  label="Divisão da tela"
                  value={regions[0]?.weight ?? 0.6}
                  min={0.2}
                  max={0.8}
                  step={0.02}
                  onChange={(top) =>
                    setRegions(([first, second, ...rest]) => [
                      { ...first, weight: top },
                      { ...second, weight: 1 - top },
                      ...rest,
                    ])
                  }
                  legend={[
                    `faixa 1: ${Math.round((regions[0]?.weight ?? 0.6) * 100)}%`,
                    "",
                    `faixa 2: ${Math.round((regions[1]?.weight ?? 0.4) * 100)}%`,
                  ]}
                />
              )}

              <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-2.5">
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                    Recomendação
                  </span>
                  <button
                    className="text-[11px] text-brand-500 hover:text-brand-400 disabled:opacity-50"
                    onClick={askSuggestion}
                    disabled={suggesting}
                  >
                    {suggesting ? "analisando..." : "reanalisar"}
                  </button>
                </div>
                <p className="text-xs leading-relaxed text-slate-400">
                  {suggestion ? suggestion.reason : suggesting ? "Detectando rostos..." : "—"}
                </p>
              </div>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 md:grid-cols-3">
            <div className="space-y-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-ink-600 bg-ink-800 accent-brand-500"
                  checked={burnSubtitles}
                  onChange={(event) => setBurnSubtitles(event.target.checked)}
                />
                Queimar legenda no vídeo
              </label>
              <p className="text-xs text-slate-500">
                {words.length} palavras neste trecho. As mudanças aparecem na prévia
                imediatamente.
              </p>
            </div>

            <div className="space-y-3">
              <Slider
                label={`Tamanho da fonte — ${style.font_size}px`}
                value={style.font_size}
                min={40}
                max={140}
                step={2}
                disabled={!burnSubtitles}
                onChange={(font_size) => setStyle((s) => ({ ...s, font_size }))}
              />
              <Slider
                label={`Altura na tela — ${style.margin_v}px da base`}
                value={style.margin_v}
                min={80}
                max={1200}
                step={10}
                disabled={!burnSubtitles}
                onChange={(margin_v) => setStyle((s) => ({ ...s, margin_v }))}
              />
              <Slider
                label={`Palavras por vez — ${style.max_words}`}
                value={style.max_words}
                min={1}
                max={8}
                step={1}
                disabled={!burnSubtitles}
                onChange={(max_words) => setStyle((s) => ({ ...s, max_words }))}
              />
            </div>

            <div className="space-y-3">
              <div>
                <span className="label">Cor do destaque</span>
                <div className="flex flex-wrap gap-2">
                  {PALETTE.map((color) => (
                    <button
                      key={color}
                      onClick={() => setStyle((s) => ({ ...s, highlight_color: color }))}
                      disabled={!burnSubtitles}
                      className={`h-8 w-8 rounded-full border-2 transition-transform disabled:opacity-40 ${
                        style.highlight_color === color
                          ? "scale-110 border-slate-100"
                          : "border-ink-600"
                      }`}
                      style={{ backgroundColor: color }}
                      aria-label={color}
                    />
                  ))}
                </div>
              </div>
              <div>
                <span className="label">Cor do texto</span>
                <div className="flex flex-wrap gap-2">
                  {["#FFFFFF", "#E2E8F0", "#0F172A"].map((color) => (
                    <button
                      key={color}
                      onClick={() => setStyle((s) => ({ ...s, primary_color: color }))}
                      disabled={!burnSubtitles}
                      className={`h-8 w-8 rounded-full border-2 transition-transform disabled:opacity-40 ${
                        style.primary_color === color
                          ? "scale-110 border-brand-500"
                          : "border-ink-600"
                      }`}
                      style={{ backgroundColor: color }}
                      aria-label={color}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-sm text-red-300">
            {error}
          </p>
        )}

        {/* --------------------------------------------------- rodapé */}
        <footer className="flex items-center justify-between gap-3 border-t border-ink-700 pt-3">
          <p className="text-xs text-slate-500">
            {selected.length} formato{selected.length > 1 ? "s" : ""} · só o trecho é codificado
          </p>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn-primary" onClick={submit} disabled={rendering || duration < 1}>
              {rendering
                ? "Gerando..."
                : `Gerar ${selected.length} vídeo${selected.length > 1 ? "s" : ""}`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function cropLeft(mode: ReframeMode, offset: number, travel: number): number {
  return mode === "manual" ? offset * travel : travel / 2;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  legend?: [string, string, string];
  disabled?: boolean;
}

function Slider({ label, value, min, max, step, onChange, legend, disabled }: SliderProps) {
  return (
    <div>
      <span className="label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-brand-500 disabled:opacity-40"
      />
      {legend && (
        <div className="flex justify-between text-[11px] text-slate-500">
          {legend.map((text, index) => (
            <span key={index}>{text}</span>
          ))}
        </div>
      )}
    </div>
  );
}

interface TimeControlProps {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  onNudge: (delta: number) => void;
}

function TimeControl({ label, value, max, onChange, onNudge }: TimeControlProps) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
        <span className="font-mono text-xs text-slate-300">{clock(value)}</span>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="rounded border border-ink-600 px-2 py-0.5 text-xs text-slate-400 hover:bg-ink-800"
          onClick={() => onNudge(-1)}
        >
          −1s
        </button>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="flex-1 accent-brand-500"
        />
        <button
          className="rounded border border-ink-600 px-2 py-0.5 text-xs text-slate-400 hover:bg-ink-800"
          onClick={() => onNudge(1)}
        >
          +1s
        </button>
      </div>
    </div>
  );
}
