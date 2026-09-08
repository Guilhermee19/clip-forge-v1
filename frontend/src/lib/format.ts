/** Formatadores usados pela interface. */

/** Segundos -> `1:23` ou `1:02:03`. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;

  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

/** Score 0-1 -> `87`. */
export function scoreLabel(score: number): string {
  return String(Math.round(score * 100));
}

/** Cor do score, do vermelho (fraco) ao verde-agua (forte). */
export function scoreColor(score: number): string {
  if (score >= 0.75) return "text-brand-400";
  if (score >= 0.5) return "text-amber-400";
  return "text-slate-400";
}

export function reframeLabel(mode: string): string {
  const labels: Record<string, string> = {
    single: "Câmera seguindo o falante",
    split: "Split-screen (2 pessoas)",
    center: "Crop central",
  };
  return labels[mode] ?? mode;
}
