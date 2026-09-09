import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../lib/types";

interface Props {
  jobId: string;
  candidate: ClipCandidate;
  media: MediaInfo;
  formats: FormatOption[];
  onRendered: (clips: RenderedClip[]) => void;
  onClose: () => void;
}

const REFRAME_OPTIONS: { value: ReframeMode; label: string; hint: string }[] = [
  { value: "auto", label: "Automático", hint: "Detecta rostos e decide sozinho" },
  { value: "single", label: "Seguir o falante", hint: "Uma câmera acompanha quem fala" },
  { value: "split", label: "Split-screen", hint: "Duas pessoas empilhadas" },
  { value: "center", label: "Centro fixo", hint: "Sem detecção de rosto" },
  { value: "manual", label: "Posição manual", hint: "Você escolhe onde a câmera fica" },
  {
    value: "composite",
    label: "Gameplay + webcam",
    hint: "Empilha duas áreas da tela; arraste os retângulos na prévia",
  },
];

/** Faixas padrão quando você liga o modo composto sem uma sugestão pronta. */
const DEFAULT_REGIONS: LayoutRegion[] = [
  { x: 0.15, y: 0.08, width: 0.7, height: 0.6, weight: 0.62, label: "Conteúdo" },
  { x: 0.62, y: 0.55, width: 0.34, height: 0.4, weight: 0.38, label: "Webcam" },
];

/**
 * Editor de um corte: prévia, trim, formatos e reposicionamento do conteúdo.
 *
 * A prévia toca o vídeo de origem no trecho escolhido, com uma moldura por cima
 * mostrando o que sobra depois do crop. Nada é codificado até você clicar em
 * gerar, então ajustar é instantâneo — é um `currentTime`, não um encode.
 */
export function ClipEditor({ jobId, candidate, media, formats, onRendered, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);

  const [start, setStart] = useState(candidate.start_time);
  const [end, setEnd] = useState(candidate.end_time);
  const [title, setTitle] = useState(candidate.title);
  const [selected, setSelected] = useState<AspectRatio[]>(["9:16"]);
  const [reframe, setReframe] = useState<ReframeMode>("auto");
  const [offset, setOffset] = useState(0.5);
  const [regions, setRegions] = useState<LayoutRegion[]>(DEFAULT_REGIONS);
  const [activeRegion, setActiveRegion] = useState(0);
  const [subtitles, setSubtitles] = useState(true);
  const [suggestion, setSuggestion] = useState<LayoutSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(candidate.start_time);

  const duration = Math.max(0, end - start);
  const primary = formats.find((f) => f.value === selected[0]);
  const targetRatio = primary ? primary.width / primary.height : 9 / 16;
  const sourceRatio = media.width / media.height;
  const cropFraction = Math.min(1, targetRatio / sourceRatio);
  const travel = 1 - cropFraction;
  const composing = reframe === "composite";

  // ------------------------------------------------------------- sugestão

  const askSuggestion = useCallback(async () => {
    setSuggesting(true);
    setError(null);
    try {
      const result = await api.suggestLayout(jobId, start, end);
      setSuggestion(result);
      setReframe(result.mode);
      setSelected([result.aspect_ratio]);
      if (result.regions.length > 0) {
        setRegions(result.regions);
      }
    } catch (exception) {
      setError((exception as Error).message);
    } finally {
      setSuggesting(false);
    }
  }, [jobId, start, end]);

  // Analisa assim que o editor abre: a recomendação é o ponto de partida, e o
  // usuário só mexe no que discordar.
  useEffect(() => {
    askSuggestion();
    // Intencionalmente só no mount: reanalisar a cada arraste do trim custaria
    // uma passada de MediaPipe por ajuste.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------------------------------------------------------------- player

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

  // ---------------------------------------------------------------- ações

  const toggleFormat = (value: AspectRatio) => {
    setSelected((previous) =>
      previous.includes(value)
        ? previous.filter((v) => v !== value) || previous
        : [...previous, value]
    );
  };

  const submit = async () => {
    if (selected.length === 0) {
      setError("Escolha ao menos um formato.");
      return;
    }
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
        burn_subtitles: subtitles,
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

  // ----------------------------------------------------------------- view

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink-950/90 p-4 backdrop-blur-sm">
      <div className="my-4 w-full max-w-5xl space-y-4 rounded-xl border border-ink-700 bg-ink-900 p-5">
        <header className="flex items-start justify-between gap-4">
          <input
            className="field text-base font-semibold"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Título do corte"
          />
          <button className="btn-ghost shrink-0" onClick={onClose}>
            Fechar
          </button>
        </header>

        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          {/* ------------------------------------------------- prévia */}
          <div className="space-y-3">
            <div className="relative overflow-hidden rounded-lg bg-black">
              <video
                ref={videoRef}
                className="w-full"
                src={api.sourceUrl(jobId)}
                controls
                muted
                onTimeUpdate={enforceRange}
                onLoadedMetadata={() => seekTo(start)}
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

              <span className="pointer-events-none absolute left-2 top-2 rounded bg-ink-950/80 px-2 py-0.5 font-mono text-xs text-slate-300">
                {clock(playhead)} / {clock(media.duration)}
              </span>
            </div>

            {composing ? (
              <p className="text-xs text-slate-500">
                Arraste os retângulos para escolher o que vai em cada faixa. A{" "}
                <span className="text-brand-400">faixa 1</span> fica em cima no vídeo final,
                a <span className="text-amber-400">faixa 2</span> embaixo.
              </p>
            ) : (
              <p className="text-xs text-slate-500">
                A moldura mostra a proporção {selected[0]}. No modo{" "}
                <span className="text-slate-300">
                  {REFRAME_OPTIONS.find((o) => o.value === reframe)?.label.toLowerCase()}
                </span>
                , a posição real é calculada por frame a partir dos rostos detectados.
              </p>
            )}

            {/* ---------------------------------------------- trim */}
            <div className="space-y-3 rounded-lg border border-ink-700 bg-ink-800/40 p-3">
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
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-500">
                  Duração{" "}
                  <span
                    className={duration < 5 || duration > 180 ? "text-amber-400" : "text-slate-200"}
                  >
                    {duration.toFixed(1)}s
                  </span>
                </span>
                <button className="text-slate-400 hover:text-brand-400" onClick={() => seekTo(start)}>
                  Voltar ao início do corte
                </button>
              </div>
            </div>
          </div>

          {/* ------------------------------------------------ ajustes */}
          <div className="space-y-4">
            {/* sugestão */}
            <div className="rounded-lg border border-ink-700 bg-ink-800/40 p-3">
              <div className="mb-1 flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Recomendação
                </span>
                <button
                  className="text-xs text-brand-500 hover:text-brand-400 disabled:opacity-50"
                  onClick={askSuggestion}
                  disabled={suggesting}
                >
                  {suggesting ? "analisando..." : "reanalisar"}
                </button>
              </div>
              {suggestion ? (
                <>
                  <p className="text-sm text-slate-200">
                    {REFRAME_OPTIONS.find((o) => o.value === suggestion.mode)?.label} ·{" "}
                    {suggestion.aspect_ratio}
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">{suggestion.reason}</p>
                </>
              ) : (
                <p className="text-xs text-slate-500">
                  {suggesting ? "Detectando rostos no trecho..." : "Sem análise ainda."}
                </p>
              )}
            </div>

            {/* formatos: múltipla escolha */}
            <div>
              <span className="label">Formatos a gerar</span>
              <div className="grid grid-cols-2 gap-2">
                {formats.map((option) => {
                  const on = selected.includes(option.value);
                  const recommended = suggestion?.aspect_ratio === option.value;
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
                      {recommended && (
                        <span className="absolute right-1.5 top-1.5 text-[10px] text-brand-500">
                          ★
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {selected.length} selecionado{selected.length > 1 ? "s" : ""} · um arquivo por
                formato
              </p>
            </div>

            {/* enquadramento */}
            <div>
              <label className="label" htmlFor="reframe-mode">
                Reposicionamento do conteúdo
              </label>
              <select
                id="reframe-mode"
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
              <div>
                <label className="label" htmlFor="offset">
                  Posição horizontal
                </label>
                <input
                  id="offset"
                  type="range"
                  min={0}
                  max={1}
                  step={0.01}
                  value={offset}
                  onChange={(event) => setOffset(Number(event.target.value))}
                  className="w-full accent-brand-500"
                />
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>esquerda</span>
                  <span>centro</span>
                  <span>direita</span>
                </div>
              </div>
            )}

            {composing && (
              <div>
                <label className="label" htmlFor="split-weight">
                  Divisão da tela
                </label>
                <input
                  id="split-weight"
                  type="range"
                  min={0.2}
                  max={0.8}
                  step={0.02}
                  value={regions[0]?.weight ?? 0.6}
                  onChange={(event) => {
                    const top = Number(event.target.value);
                    setRegions(([first, second, ...rest]) => [
                      { ...first, weight: top },
                      { ...second, weight: 1 - top },
                      ...rest,
                    ]);
                  }}
                  className="w-full accent-brand-500"
                />
                <div className="flex justify-between text-[11px] text-slate-500">
                  <span>faixa 1: {Math.round((regions[0]?.weight ?? 0.6) * 100)}%</span>
                  <span>faixa 2: {Math.round((regions[1]?.weight ?? 0.4) * 100)}%</span>
                </div>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-ink-600 bg-ink-800 accent-brand-500"
                checked={subtitles}
                onChange={(event) => setSubtitles(event.target.checked)}
              />
              Queimar legenda animada
            </label>

            {error && (
              <p className="rounded-lg border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">
                {error}
              </p>
            )}

            <button
              className="btn-primary w-full"
              onClick={submit}
              disabled={rendering || duration < 1 || selected.length === 0}
            >
              {rendering
                ? "Renderizando..."
                : `Gerar ${selected.length} vídeo${selected.length > 1 ? "s" : ""}`}
            </button>
            <p className="text-center text-[11px] text-slate-600">
              Só o trecho escolhido é codificado — poucos segundos por formato.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Posição da moldura na prévia: manual respeita o slider, o resto centraliza. */
function cropLeft(mode: ReframeMode, offset: number, travel: number): number {
  return mode === "manual" ? offset * travel : travel / 2;
}

interface TimeControlProps {
  label: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
  onNudge: (delta: number) => void;
}

/** Slider + passos finos para ajustar um dos limites do corte. */
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
          title="1 segundo antes"
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
          title="1 segundo depois"
        >
          +1s
        </button>
      </div>
    </div>
  );
}
