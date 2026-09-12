import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Sparkles,
  Volume2,
  VolumeX,
  Wand2,
  X,
} from "lucide-react";
import { CameraTimeline } from "@/components/CameraTimeline";
import { FramePicker } from "@/components/FramePicker";
import { LivePreview } from "@/components/LivePreview";
import { RegionPicker } from "@/components/RegionPicker";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { api } from "@/lib/api";
import {
  bandRatio,
  clamp,
  cropWindow,
  defaultKeyframes,
  fitBands,
  sampleCamera,
} from "@/lib/camera";
import { cn } from "@/lib/cn";
import { clock } from "@/lib/format";
import type {
  AspectRatio,
  CameraKeyframe,
  ClipCandidate,
  FormatOption,
  LayoutRegion,
  LayoutSuggestion,
  MediaInfo,
  ReframeMode,
  RenderedClip,
  SubtitlePreset,
  SubtitleStyle,
  Word,
} from "@/lib/types";

interface Props {
  projectId: string;
  candidate: ClipCandidate;
  media: MediaInfo;
  formats: FormatOption[];
  onRendered: (clips: RenderedClip[]) => void;
  onClose: () => void;
}

type Tab = "frame" | "trim" | "captions";

const TABS: [Tab, string][] = [
  ["frame", "Enquadramento"],
  ["trim", "Corte e formato"],
  ["captions", "Legendas"],
];

/** Modos de painel único que a análise decide sozinha. */
const AUTO_MODES: { value: ReframeMode; label: string; hint: string }[] = [
  { value: "auto", label: "Automático", hint: "Detecta rostos e decide sozinho" },
  { value: "single", label: "Seguir o falante", hint: "Uma câmera acompanha quem fala" },
  { value: "split", label: "Split-screen", hint: "Duas pessoas empilhadas" },
  { value: "center", label: "Centro fixo", hint: "Sem detecção de rosto" },
];

const DEFAULT_REGIONS: LayoutRegion[] = [
  { x: 0.15, y: 0.08, width: 0.7, height: 0.6, weight: 0.62, label: "Conteúdo" },
  { x: 0.62, y: 0.55, width: 0.34, height: 0.4, weight: 0.38, label: "Webcam" },
];

const SUBTITLE_PRESETS: { value: SubtitlePreset; label: string; hint: string }[] = [
  { value: "karaoke", label: "Karaokê", hint: "Frase na tela, palavra falada em cor" },
  { value: "word", label: "Uma palavra", hint: "Uma de cada vez, bem grande" },
  { value: "block", label: "Caixa", hint: "Fundo sólido atrás do texto" },
  { value: "clean", label: "Sem destaque", hint: "Só contorno grosso, sem cor" },
];

const DEFAULT_STYLE: SubtitleStyle = {
  font_size: 84,
  preset: "karaoke",
  pos_x: null,
  pos_y: null,
  margin_v: 420,
  primary_color: "#FFFFFF",
  highlight_color: "#FFE500",
  max_words: 4,
};

const PALETTE = ["#FFE500", "#2DD4BF", "#F472B6", "#FB923C", "#A78BFA", "#FFFFFF"];

/** Saltos oferecidos para esticar ou encurtar o corte, em segundos. */
const TRIM_STEPS = [5, 10, 20, 30];

/** Um corte precisa sobrar alguma coisa: o encolhimento para aqui. */
const MIN_DURATION = 1.5;

/**
 * Editor de um corte: original de um lado, resultado ao vivo do outro.
 *
 * O painel da esquerda é o vídeo 16:9 com o retângulo do enquadramento; o do
 * meio é um canvas que redesenha a composição a cada frame, com a mesma
 * matemática de recorte que o FFmpeg vai usar. Nenhum arquivo é gerado até
 * clicar em salvar, então experimentar é instantâneo.
 */
export function ClipEditor({ projectId, candidate, media, formats, onRendered, onClose }: Props) {
  // Um único estado guarda o elemento: serve de "ref" para os comandos de
  // playback e dispara o render quando o player aparece, para a prévia começar.
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);

  const [tab, setTab] = useState<Tab>("frame");
  const [start, setStart] = useState(candidate.start_time);
  const [end, setEnd] = useState(candidate.end_time);
  const [title, setTitle] = useState(candidate.title);
  const [selected, setSelected] = useState<AspectRatio[]>(["9:16"]);
  const [reframe, setReframe] = useState<ReframeMode>("auto");
  const [regions, setRegions] = useState<LayoutRegion[]>(DEFAULT_REGIONS);
  const [activeRegion, setActiveRegion] = useState(0);
  const [keyframes, setKeyframes] = useState<CameraKeyframe[]>(defaultKeyframes);
  const [activeKey, setActiveKey] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [burnSubtitles, setBurnSubtitles] = useState(true);
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_STYLE);
  const [words, setWords] = useState<Word[]>([]);
  const [suggestion, setSuggestion] = useState<LayoutSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playhead, setPlayhead] = useState(candidate.start_time);
  const [volume, setVolume] = useState(0.8);
  const [muted, setMuted] = useState(false);
  const [trimStep, setTrimStep] = useState(10);

  const duration = Math.max(0, end - start);
  const previewAspect = selected[0] ?? "9:16";
  const composing = reframe === "composite";
  const keyframing = reframe === "keyframe";

  const format = formats.find((f) => f.value === previewAspect);
  const targetRatio = format ? format.width / format.height : 9 / 16;

  const baseWindow = useMemo(
    () => cropWindow(media.width, media.height, targetRatio, 1),
    [media.width, media.height, targetRatio],
  );
  const window_ = useMemo(
    () => cropWindow(media.width, media.height, targetRatio, zoom),
    [media.width, media.height, targetRatio, zoom],
  );

  // Onde o retângulo aparece agora. Nos modos automáticos não sabemos a
  // trajetória que o backend vai calcular, então mostramos o centro — assim
  // que a pessoa arrasta, o modo vira manual e a posição passa a ser dela.
  const center = keyframing
    ? sampleCamera(keyframes, playhead - start)
    : { x: 0.5, y: 0.5 };

  // ------------------------------------------------------------ dados

  const askSuggestion = useCallback(async () => {
    setSuggesting(true);
    setError(null);
    try {
      const result = await api.suggestLayout(projectId, start, end);
      setSuggestion(result);
      setReframe(result.mode);
      setSelected([result.aspect_ratio]);
      if (result.regions.length > 0) setRegions(result.regions);
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setSuggesting(false);
    }
  }, [projectId, start, end]);

  useEffect(() => {
    askSuggestion();
    // Só no mount: reanalisar a cada ajuste custaria uma passada de MediaPipe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A marcação de cada faixa só vale se tiver a proporção da faixa final, e
  // isso muda quando o formato de saída muda.
  useEffect(() => {
    if (!composing) return;
    setRegions((previous) => fitBands(previous, media.width, media.height, targetRatio));
  }, [composing, targetRatio, media.width, media.height]);

  // As palavras alimentam a legenda desenhada na prévia.
  useEffect(() => {
    api
      .words(projectId, start, end)
      .then(setWords)
      .catch(() => setWords([]));
  }, [projectId, start, end]);

  // Fechar com Esc: o editor ocupa a tela toda, o X nem sempre está à mão.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    globalThis.addEventListener("keydown", onKey);
    return () => globalThis.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ----------------------------------------------------------- player

  const enforceRange = useCallback(() => {
    if (!videoEl) return;
    if (videoEl.currentTime < start - 0.3 || videoEl.currentTime > end) {
      videoEl.currentTime = start;
    }
    setPlayhead(videoEl.currentTime);
  }, [videoEl, start, end]);

  const seekTo = useCallback(
    (time: number) => {
      if (videoEl) videoEl.currentTime = time;
      setPlayhead(time);
    },
    [videoEl],
  );

  // O elemento nasce sem áudio; o volume vem do controle, não do atributo.
  useEffect(() => {
    if (!videoEl) return;
    videoEl.volume = volume;
    videoEl.muted = muted;
  }, [videoEl, volume, muted]);

  const togglePlay = () => {
    if (!videoEl) return;
    if (videoEl.paused) {
      if (videoEl.currentTime < start || videoEl.currentTime > end) videoEl.currentTime = start;
      videoEl.play();
    } else {
      videoEl.pause();
    }
  };

  // ------------------------------------------------------------ ações

  /**
   * Arrastar o retângulo é o gesto que liga a câmera manual: nos modos
   * automáticos a primeira posição vira o keyframe inicial, e dali em diante
   * quem manda é a timeline.
   */
  const moveCamera = (next: { x: number; y: number }) => {
    const relative = clamp(playhead - start, 0, duration);

    if (!keyframing) {
      setReframe("keyframe");
      setKeyframes([{ t: 0, x: next.x, y: next.y, hold: true }]);
      setActiveKey(0);
      return;
    }

    const sorted = [...keyframes].sort((a, b) => a.t - b.t);
    const index = sorted.findIndex((key) => Math.abs(key.t - relative) < 0.25);

    if (index === -1) {
      // Sem marca neste instante, move a que estiver em edição: evita criar
      // keyframe sem querer só por encostar no retângulo.
      const target = Math.min(activeKey, sorted.length - 1);
      setKeyframes(sorted.map((key, i) => (i === target ? { ...key, ...next } : key)));
      return;
    }

    setActiveKey(index);
    setKeyframes(sorted.map((key, i) => (i === index ? { ...key, ...next } : key)));
  };

  /** Mudar a divisão muda a forma da faixa, então a marcação acompanha. */
  const setSplitWeight = (top: number) => {
    setRegions((previous) => {
      const [first, second, ...rest] = previous;
      return fitBands(
        [{ ...first, weight: top }, { ...second, weight: 1 - top }, ...rest],
        media.width,
        media.height,
        targetRatio,
      );
    });
  };

  /**
   * Move as bordas do corte, cada uma pelo seu delta.
   *
   * Os dois limites saem juntos porque eles se empurram: esticar o início até
   * o começo do vídeo não pode arrastar o fim, e encurtar demais não pode
   * inverter o corte.
   */
  const nudgeRange = (deltaStart: number, deltaEnd: number) => {
    // Encolher mais do que o corte tem não faz sentido. Sem isto, pedir −30s
    // num corte de 4s empurrava a janela inteira 30s adiante no vídeo em vez de
    // parar no mínimo; o pedido é aparado ao espaço que realmente sobra.
    const shrink = Math.max(0, deltaStart) + Math.max(0, -deltaEnd);
    const room = Math.max(0, duration - MIN_DURATION);
    const scale = shrink > room ? room / shrink : 1;

    const appliedStart = deltaStart > 0 ? deltaStart * scale : deltaStart;
    const appliedEnd = deltaEnd < 0 ? deltaEnd * scale : deltaEnd;

    const nextStart = clamp(start + appliedStart, 0, media.duration - MIN_DURATION);
    const nextEnd = clamp(end + appliedEnd, nextStart + MIN_DURATION, media.duration);

    setStart(Math.min(nextStart, nextEnd - MIN_DURATION));
    setEnd(nextEnd);

    // Leva o player para a borda que acabou de mudar: mexer no fim e continuar
    // vendo o começo não diz se o corte ficou bom.
    seekTo(deltaStart !== 0 ? nextStart : Math.max(nextStart, nextEnd - 2));
  };

  const toggleFormat = (value: AspectRatio) => {
    setSelected((previous) => {
      if (!previous.includes(value)) return [...previous, value];
      const rest = previous.filter((v) => v !== value);
      return rest.length > 0 ? rest : previous;
    });
  };

  const submit = async () => {
    setRendering(true);
    setError(null);
    try {
      const response = await api.renderClip(projectId, {
        candidate_id: candidate.id,
        start_time: Number(start.toFixed(2)),
        end_time: Number(end.toFixed(2)),
        title,
        aspect_ratios: selected,
        reframe_mode: reframe,
        manual_offset: null,
        regions: composing ? regions : null,
        camera_keyframes: keyframing ? keyframes : null,
        zoom: keyframing ? zoom : 1,
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

  // ------------------------------------------------------------- view

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 p-2 backdrop-blur-sm sm:p-4">
      <div className="hairline flex h-full flex-col overflow-hidden rounded-3xl border border-line bg-surface">
        {/* --------------------------------------------------- cabeçalho */}
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <input
            className="min-w-48 flex-1 rounded-full border border-line bg-surface-2 px-4 py-2 text-[14px] font-semibold text-ink focus:border-accent focus:outline-none"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Título do corte"
          />

          <nav className="flex items-center gap-1 rounded-full bg-surface-2 p-1">
            {TABS.map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={cn(
                  "h-8 cursor-pointer rounded-full px-3.5 text-[12px] font-medium transition-colors",
                  tab === value
                    ? "bg-accent text-accent-ink"
                    : "text-muted hover:bg-surface-3 hover:text-ink",
                )}
              >
                {label}
              </button>
            ))}
          </nav>

          <Button variant="ghost" size="icon" aria-label="Fechar editor" onClick={onClose}>
            <X className="size-4" strokeWidth={2} />
          </Button>
        </header>

        {/* ------------------------------------------------------ corpo */}
        {/* Abaixo de `lg` as três áreas empilham e a página rola; a partir daí
            elas dividem a altura e cada uma rola por dentro. */}
        <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1fr)_minmax(210px,0.55fr)_300px] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_minmax(240px,0.6fr)_340px]">
          {/* ------------------------------------ original + timeline */}
          <section className="flex min-h-0 min-w-0 flex-col gap-3">
            <div className="flex items-baseline justify-between">
              <p className="text-[11px] font-medium tracking-wide text-faint uppercase">
                Original {media.width}×{media.height}
              </p>
              {!composing && (
                <p className="text-[11px] text-faint">
                  arraste o retângulo para escolher o que aparece
                </p>
              )}
            </div>

            {/* A caixa tem a proporção exata do vídeo e é limitada pela
                largura. Nada de `max-height` aqui: com a largura já definida,
                limitar a altura achataria a caixa, o vídeo esticaria e o
                retângulo de enquadramento passaria a apontar para o lugar
                errado. */}
            <div className="flex min-h-0 flex-1 items-start justify-center">
              <div
                className="relative w-full max-w-full overflow-hidden rounded-2xl bg-black"
                style={{ aspectRatio: `${media.width} / ${media.height}` }}
              >
                <video
                  ref={setVideoEl}
                  className="size-full"
                  src={api.sourceUrl(projectId)}
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
                  ratioFor={(index) =>
                    bandRatio(
                      media.width,
                      media.height,
                      targetRatio,
                      regions[index]?.weight ?? 0.5,
                    )
                  }
                />
              ) : (
                <FramePicker
                  window={window_}
                  center={center}
                  onMove={moveCamera}
                  onZoom={(value) => {
                    if (!keyframing) {
                      setReframe("keyframe");
                      setKeyframes([{ t: 0, x: center.x, y: center.y, hold: true }]);
                      setActiveKey(0);
                    }
                    setZoom(value);
                  }}
                  zoom={zoom}
                  baseWidth={baseWindow.width}
                  editable
                />
              )}
              </div>
            </div>

            {/* ----------------------------------------- transporte */}
            <div className="flex shrink-0 items-center gap-3 rounded-2xl border border-line bg-surface-2 px-3 py-2">
              <button
                className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-accent-ink transition-colors hover:bg-accent-hover"
                onClick={togglePlay}
                aria-label={playing ? "Pausar" : "Reproduzir"}
              >
                {playing ? (
                  <Pause className="size-4" strokeWidth={2.4} />
                ) : (
                  <Play className="size-4" strokeWidth={2.4} />
                )}
              </button>
              <input
                type="range"
                min={start}
                max={end}
                step={0.05}
                value={clamp(playhead, start, end)}
                onChange={(event) => seekTo(Number(event.target.value))}
                className="flex-1 accent-(--c-accent)"
                aria-label="Posição no corte"
              />
              <span className="num w-24 shrink-0 text-right text-[12px] text-muted">
                {clock(playhead - start)} / {clock(duration)}
              </span>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  onClick={() => setMuted((value) => !value)}
                  aria-label={muted ? "Ativar som" : "Silenciar"}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-3 hover:text-ink"
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="size-4" strokeWidth={1.9} />
                  ) : (
                    <Volume2 className="size-4" strokeWidth={1.9} />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(event) => {
                    setVolume(Number(event.target.value));
                    setMuted(false);
                  }}
                  className="w-20 accent-(--c-accent)"
                  aria-label="Volume"
                />
              </div>
            </div>

            {composing ? (
              <BandList regions={regions} active={activeRegion} onSelect={setActiveRegion} />
            ) : (
              <CameraTimeline
                keyframes={keyframing ? keyframes : defaultKeyframes()}
                onChange={(next) => {
                  if (!keyframing) setReframe("keyframe");
                  setKeyframes(next);
                }}
                duration={duration}
                playhead={clamp(playhead - start, 0, duration)}
                onSeek={(relative) => seekTo(start + relative)}
                active={activeKey}
                onSelect={setActiveKey}
              />
            )}
          </section>

          {/* --------------------------------------------- resultado */}
          <section className="flex min-h-0 min-w-0 flex-col gap-3">
            <p className="text-[11px] font-medium tracking-wide text-faint uppercase">
              Resultado {previewAspect}
            </p>
            <div className="flex min-h-0 flex-1 items-start justify-center">
              <LivePreview
                video={videoEl}
                aspect={previewAspect}
                mode={reframe}
                regions={regions}
                manualOffset={0.5}
                keyframes={keyframes}
                zoom={zoom}
                sourceWidth={media.width}
                sourceHeight={media.height}
                words={words}
                subtitles={burnSubtitles}
                style={style}
                clipStart={start}
                onMoveCaption={(position) =>
                  setStyle((previous) => ({
                    ...previous,
                    pos_x: Number(position.x.toFixed(3)),
                    pos_y: Number(position.y.toFixed(3)),
                  }))
                }
              />
            </div>
          </section>

          {/* --------------------------------------------- controles */}
          <aside className="scroll-thin flex min-h-0 min-w-0 flex-col gap-4 lg:overflow-y-auto">
            {tab === "frame" && (
              <FrameTab
                reframe={reframe}
                setReframe={setReframe}
                composing={composing}
                keyframing={keyframing}
                regions={regions}
                setRegions={setRegions}
                onSplitWeight={setSplitWeight}
                zoom={zoom}
                setZoom={setZoom}
                keyframes={keyframes}
                setKeyframes={setKeyframes}
                setActiveKey={setActiveKey}
                center={center}
                suggestion={suggestion}
                suggesting={suggesting}
                onReanalyse={askSuggestion}
                defaultRegions={DEFAULT_REGIONS}
              />
            )}

            {tab === "trim" && (
              <TrimTab
                start={start}
                end={end}
                duration={duration}
                mediaDuration={media.duration}
                onStart={(value) => {
                  const next = Math.min(value, end - 1);
                  setStart(next);
                  seekTo(next);
                }}
                onEnd={(value) => setEnd(Math.max(value, start + MIN_DURATION))}
                onNudge={nudgeRange}
                step={trimStep}
                onStep={setTrimStep}
                formats={formats}
                selected={selected}
                onToggleFormat={toggleFormat}
                suggested={suggestion?.aspect_ratio}
              />
            )}

            {tab === "captions" && (
              <CaptionsTab
                burn={burnSubtitles}
                setBurn={setBurnSubtitles}
                style={style}
                setStyle={setStyle}
                wordCount={words.length}
              />
            )}
          </aside>
        </div>

        {/* ------------------------------------------------------ rodapé */}
        <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
          <div className="min-w-0">
            {error ? (
              <p className="truncate text-[12px] text-rose">{error}</p>
            ) : (
              <p className="text-[12px] text-faint">
                {selected.length} formato{selected.length > 1 ? "s" : ""} · só o trecho é
                codificado
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button variant="accent" onClick={submit} disabled={rendering || duration < 1}>
              <Sparkles className="size-4" strokeWidth={2.2} />
              {rendering
                ? "Gerando…"
                : `Gerar ${selected.length} vídeo${selected.length > 1 ? "s" : ""}`}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- abas

function FrameTab({
  reframe,
  setReframe,
  composing,
  keyframing,
  regions,
  setRegions,
  onSplitWeight,
  zoom,
  setZoom,
  keyframes,
  setKeyframes,
  setActiveKey,
  center,
  suggestion,
  suggesting,
  onReanalyse,
  defaultRegions,
}: {
  reframe: ReframeMode;
  setReframe: (mode: ReframeMode) => void;
  composing: boolean;
  keyframing: boolean;
  regions: LayoutRegion[];
  setRegions: (regions: LayoutRegion[]) => void;
  onSplitWeight: (top: number) => void;
  zoom: number;
  setZoom: (zoom: number) => void;
  keyframes: CameraKeyframe[];
  setKeyframes: (keyframes: CameraKeyframe[]) => void;
  setActiveKey: (index: number) => void;
  center: { x: number; y: number };
  suggestion: LayoutSuggestion | null;
  suggesting: boolean;
  onReanalyse: () => void;
  defaultRegions: LayoutRegion[];
}) {
  const layout = composing ? "duplo" : keyframing ? "manual" : "auto";

  return (
    <>
      <Field label="Layout">
        <div className="grid grid-cols-3 gap-1.5">
          <LayoutButton
            on={layout === "auto"}
            label="Automático"
            onClick={() => setReframe(suggestion?.mode === "composite" ? "center" : "auto")}
          />
          <LayoutButton
            on={layout === "manual"}
            label="Câmera manual"
            onClick={() => {
              setReframe("keyframe");
              setKeyframes([{ t: 0, x: center.x, y: center.y, hold: true }]);
              setActiveKey(0);
            }}
          />
          <LayoutButton
            on={layout === "duplo"}
            label="2 painéis"
            onClick={() => {
              setReframe("composite");
              if (regions.length < 2) setRegions(defaultRegions);
            }}
          />
        </div>
      </Field>

      {layout === "auto" && (
        <Field label="Como enquadrar">
          <div className="flex flex-col gap-1.5">
            {AUTO_MODES.map((option) => (
              <button
                key={option.value}
                onClick={() => setReframe(option.value)}
                className={cn(
                  "cursor-pointer rounded-2xl border px-3 py-2 text-left transition-colors",
                  reframe === option.value
                    ? "border-accent bg-accent/10"
                    : "border-line hover:bg-surface-2",
                )}
              >
                <span className="block text-[12px] font-medium">{option.label}</span>
                <span className="block text-[11px] text-faint">{option.hint}</span>
              </button>
            ))}
          </div>
        </Field>
      )}

      {keyframing && (
        <>
          <Field label={`Zoom — ${zoom.toFixed(1)}×`}>
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
              className="w-full accent-(--c-accent)"
            />
            <p className="mt-1 text-[11px] text-faint">
              Fecha o enquadramento no corte inteiro. O tamanho da janela não pode variar no
              tempo — só para onde ela aponta.
            </p>
          </Field>

          <div className="rounded-2xl border border-line bg-surface-2 p-3">
            <p className="text-[11px] leading-relaxed text-muted">
              <span className="font-medium text-ink">{keyframes.length} posição
              {keyframes.length === 1 ? "" : "es"}</span> marcada
              {keyframes.length === 1 ? "" : "s"}. Leve a cabeça de leitura até o instante em que
              o enquadramento deve mudar, clique em <span className="text-ink">Marcar posição
              aqui</span> e arraste o retângulo para o novo lugar.
            </p>
          </div>
        </>
      )}

      {composing && (
        <Field label={`Divisão da tela — ${Math.round((regions[0]?.weight ?? 0.6) * 100)}% em cima`}>
          <input
            type="range"
            min={0.2}
            max={0.8}
            step={0.02}
            value={regions[0]?.weight ?? 0.6}
            onChange={(event) => onSplitWeight(Number(event.target.value))}
            className="w-full accent-(--c-accent)"
          />
          <p className="mt-1 text-[11px] text-faint">
            As marcações no vídeo já têm a proporção da faixa final, então o que você marca é
            o que sai. Arraste para mover e use a alça do canto para escalar.
          </p>
        </Field>
      )}

      <div className="rounded-2xl border border-line bg-surface-2 p-3">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[11px] font-medium tracking-wide text-faint uppercase">
            Recomendação
          </span>
          <button
            className="cursor-pointer text-[11px] text-accent hover:underline disabled:opacity-50"
            onClick={onReanalyse}
            disabled={suggesting}
          >
            {suggesting ? "analisando…" : "reanalisar"}
          </button>
        </div>
        <p className="flex items-start gap-2 text-[11px] leading-relaxed text-muted">
          <Wand2 className="mt-0.5 size-3.5 shrink-0 text-faint" strokeWidth={1.9} />
          {suggestion ? suggestion.reason : suggesting ? "Detectando rostos…" : "—"}
        </p>
      </div>
    </>
  );
}

function TrimTab({
  start,
  end,
  duration,
  mediaDuration,
  onStart,
  onEnd,
  onNudge,
  step,
  onStep,
  formats,
  selected,
  onToggleFormat,
  suggested,
}: {
  start: number;
  end: number;
  duration: number;
  mediaDuration: number;
  onStart: (value: number) => void;
  onEnd: (value: number) => void;
  onNudge: (deltaStart: number, deltaEnd: number) => void;
  step: number;
  onStep: (value: number) => void;
  formats: FormatOption[];
  selected: AspectRatio[];
  onToggleFormat: (value: AspectRatio) => void;
  suggested?: string;
}) {
  return (
    <>
      <Field label="Passo dos ajustes">
        <div className="flex flex-wrap gap-1.5">
          {TRIM_STEPS.map((value) => (
            <Chip key={value} active={step === value} onClick={() => onStep(value)}>
              {value}s
            </Chip>
          ))}
        </div>
      </Field>

      <Field label="Tamanho do corte">
        <div className="grid grid-cols-2 gap-1.5">
          {/* Abre nas duas pontas de uma vez: é o caso comum de ter perdido a
              deixa no começo e o desfecho no fim. */}
          <Button variant="outline" onClick={() => onNudge(-step, step)}>
            <Maximize2 className="size-4 -rotate-45" strokeWidth={2} />
            Aumentar {step}s
          </Button>
          <Button variant="outline" onClick={() => onNudge(step, -step)}>
            <Minimize2 className="size-4 -rotate-45" strokeWidth={2} />
            Diminuir {step}s
          </Button>
        </div>
        <p className="mt-1.5 text-[11px] text-faint">
          Mexe nas duas pontas juntas. Para uma só, use os botões de início e fim abaixo.
        </p>
      </Field>

      <p className="text-[12px] text-faint">
        Duração{" "}
        <span className={cn("num", duration < 5 || duration > 180 ? "text-amber" : "text-ink")}>
          {duration.toFixed(1)}s
        </span>
      </p>

      <TimeControl
        label="Início"
        value={start}
        max={mediaDuration}
        step={step}
        onChange={onStart}
        onNudge={(delta) => onNudge(delta, 0)}
      />
      <TimeControl
        label="Fim"
        value={end}
        max={mediaDuration}
        step={step}
        onChange={onEnd}
        onNudge={(delta) => onNudge(0, delta)}
      />

      <Field label="Formatos a gerar">
        <div className="grid grid-cols-2 gap-1.5">
          {formats.map((option) => (
            <button
              key={option.value}
              onClick={() => onToggleFormat(option.value)}
              className={cn(
                "relative cursor-pointer rounded-2xl border px-3 py-2 text-left transition-colors",
                selected.includes(option.value)
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-line text-muted hover:bg-surface-2",
              )}
            >
              <span className="block text-[12px] font-semibold">{option.value}</span>
              <span className="num block text-[11px] opacity-70">
                {option.width}×{option.height}
              </span>
              {suggested === option.value && (
                <span className="absolute top-1.5 right-2 text-[10px] text-accent">★</span>
              )}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-faint">O primeiro marcado é o da prévia.</p>
      </Field>
    </>
  );
}

function CaptionsTab({
  burn,
  setBurn,
  style,
  setStyle,
  wordCount,
}: {
  burn: boolean;
  setBurn: (value: boolean) => void;
  style: SubtitleStyle;
  setStyle: (update: (previous: SubtitleStyle) => SubtitleStyle) => void;
  wordCount: number;
}) {
  const positioned = style.pos_x !== null && style.pos_y !== null;

  return (
    <>
      <button
        onClick={() => setBurn(!burn)}
        className={cn(
          "flex cursor-pointer items-center justify-between gap-3 rounded-2xl border px-3 py-2.5 text-left transition-colors",
          burn ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2",
        )}
      >
        <span className="min-w-0">
          <span className="block text-[13px] font-medium">
            {burn ? "Com legenda" : "Sem legenda"}
          </span>
          <span className="block text-[11px] text-faint">
            {burn ? `${wordCount} palavras neste trecho` : "o vídeo sai limpo"}
          </span>
        </span>
        <span
          className={cn(
            "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
            burn ? "bg-accent" : "bg-surface-3",
          )}
        >
          <span
            className={cn(
              "size-4 rounded-full bg-bg transition-transform",
              burn && "translate-x-4",
            )}
          />
        </span>
      </button>

      {burn && (
        <>
          <Field label="Tipo da legenda">
            <div className="flex flex-col gap-1.5">
              {SUBTITLE_PRESETS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => setStyle((s) => ({ ...s, preset: option.value }))}
                  className={cn(
                    "cursor-pointer rounded-2xl border px-3 py-2 text-left transition-colors",
                    style.preset === option.value
                      ? "border-accent bg-accent/10"
                      : "border-line hover:bg-surface-2",
                  )}
                >
                  <span className="block text-[12px] font-medium">{option.label}</span>
                  <span className="block text-[11px] text-faint">{option.hint}</span>
                </button>
              ))}
            </div>
          </Field>

          <Field label="Posição">
            <div className="rounded-2xl border border-line bg-surface-2 px-3 py-2.5">
              <p className="text-[11px] leading-relaxed text-muted">
                {positioned
                  ? "Posição livre: arraste a legenda na prévia para mudar."
                  : "Arraste a legenda na prévia para colocá-la onde quiser."}
              </p>
              {positioned && (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="num text-[11px] text-faint">
                    {Math.round((style.pos_x ?? 0) * 100)}% × {Math.round((style.pos_y ?? 0) * 100)}%
                  </span>
                  <Chip onClick={() => setStyle((s) => ({ ...s, pos_x: null, pos_y: null }))}>
                    Voltar para a base
                  </Chip>
                </div>
              )}
            </div>
          </Field>
        </>
      )}

      <Field label={`Tamanho da fonte — ${style.font_size}px`}>
        <input
          type="range"
          min={40}
          max={140}
          step={2}
          value={style.font_size}
          disabled={!burn}
          onChange={(event) =>
            setStyle((s) => ({ ...s, font_size: Number(event.target.value) }))
          }
          className="w-full accent-(--c-accent) disabled:opacity-40"
        />
      </Field>

      {/* Com posição livre o `margin_v` é ignorado pelo ASS, então some daqui
          para não sugerir um controle que não faz nada. */}
      {!positioned && (
        <Field label={`Altura na tela — ${style.margin_v}px da base`}>
          <input
            type="range"
            min={80}
            max={1200}
            step={10}
            value={style.margin_v}
            disabled={!burn}
            onChange={(event) => setStyle((s) => ({ ...s, margin_v: Number(event.target.value) }))}
            className="w-full accent-(--c-accent) disabled:opacity-40"
          />
        </Field>
      )}

      {style.preset !== "word" && (
      <Field label={`Palavras por vez — ${style.max_words}`}>
        <input
          type="range"
          min={1}
          max={8}
          step={1}
          value={style.max_words}
          disabled={!burn}
          onChange={(event) => setStyle((s) => ({ ...s, max_words: Number(event.target.value) }))}
          className="w-full accent-(--c-accent) disabled:opacity-40"
        />
      </Field>
      )}

      <Field label="Cor do destaque">
        <div className="flex flex-wrap gap-2">
          {PALETTE.map((color) => (
            <button
              key={color}
              onClick={() => setStyle((s) => ({ ...s, highlight_color: color }))}
              disabled={!burn}
              className={cn(
                "size-8 cursor-pointer rounded-full border-2 transition-transform disabled:opacity-40",
                style.highlight_color === color ? "scale-110 border-ink" : "border-line-strong",
              )}
              style={{ backgroundColor: color }}
              aria-label={color}
            />
          ))}
        </div>
      </Field>

      <Field label="Cor do texto">
        <div className="flex flex-wrap gap-2">
          {["#FFFFFF", "#E2E8F0", "#0F172A"].map((color) => (
            <button
              key={color}
              onClick={() => setStyle((s) => ({ ...s, primary_color: color }))}
              disabled={!burn}
              className={cn(
                "size-8 cursor-pointer rounded-full border-2 transition-transform disabled:opacity-40",
                style.primary_color === color ? "scale-110 border-accent" : "border-line-strong",
              )}
              style={{ backgroundColor: color }}
              aria-label={color}
            />
          ))}
        </div>
      </Field>
    </>
  );
}

// ------------------------------------------------------------- átomos

/**
 * As faixas do layout composto, listadas abaixo do vídeo.
 *
 * Ocupa o lugar que a timeline de câmera tem nos outros modos — sem ela a
 * coluna ficava com um buraco do tamanho da tela.
 */
function BandList({
  regions,
  active,
  onSelect,
}: {
  regions: LayoutRegion[];
  active: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12px] font-medium">Faixas</span>
      <div className="grid gap-2 sm:grid-cols-2">
        {regions.map((region, index) => (
          <button
            key={index}
            onClick={() => onSelect(index)}
            className={cn(
              "flex cursor-pointer items-center gap-2.5 rounded-2xl border px-3 py-2 text-left transition-colors",
              index === active ? "border-accent bg-accent/10" : "border-line hover:bg-surface-2",
            )}
          >
            <span
              className={cn(
                "num flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
                index === 0 ? "bg-accent text-accent-ink" : "bg-amber text-accent-ink",
              )}
            >
              {index + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium">
                {region.label || `Faixa ${index + 1}`}
              </span>
              <span className="num block text-[11px] text-faint">
                {Math.round(region.weight * 100)}% da altura
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-faint">
        Clique para focar uma faixa e arraste o retângulo dela no vídeo.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="mb-1.5 block text-[11px] font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function LayoutButton({
  on,
  label,
  onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "cursor-pointer rounded-2xl border px-2 py-2 text-[11px] font-medium transition-colors",
        on ? "border-accent bg-accent/10 text-accent" : "border-line text-muted hover:bg-surface-2",
      )}
    >
      {label}
    </button>
  );
}

function TimeControl({
  label,
  value,
  max,
  step,
  onChange,
  onNudge,
}: {
  label: string;
  value: number;
  max: number;
  /** Quantos segundos cada botão move esta borda. */
  step: number;
  onChange: (value: number) => void;
  onNudge: (delta: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">{label}</span>
        <span className="num text-[12px] text-ink">{clock(value)}</span>
      </div>
      <div className="flex items-center gap-2">
        <Chip onClick={() => onNudge(-step)}>−{step}s</Chip>
        <input
          type="range"
          min={0}
          max={max}
          step={0.1}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="flex-1 accent-(--c-accent)"
          aria-label={label}
        />
        <Chip onClick={() => onNudge(step)}>+{step}s</Chip>
      </div>
    </div>
  );
}
