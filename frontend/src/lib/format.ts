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
  if (score >= 0.75) return "text-accent";
  if (score >= 0.5) return "text-amber";
  return "text-muted";
}

export function reframeLabel(mode: string): string {
  const labels: Record<string, string> = {
    single: "Câmera seguindo o falante",
    split: "Split-screen (2 pessoas)",
    center: "Crop central",
  };
  return labels[mode] ?? mode;
}

/** Timestamp unix -> `agora`, `há 3 h`, `12/09`. */
export function since(timestamp: number): string {
  const seconds = Math.max(0, Date.now() / 1000 - timestamp);

  if (seconds < 60) return "agora";
  if (seconds < 3600) return `há ${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `há ${Math.floor(seconds / 3600)} h`;
  if (seconds < 604_800) return `há ${Math.floor(seconds / 86_400)} d`;

  return new Date(timestamp * 1000).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
  });
}

/** Bytes -> `1,9 GB` / `240 MB` / `18 kB`. */
export function bytes(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace(".", ",")} GB`;
  if (value >= 1e6) return `${Math.round(value / 1e6)} MB`;
  if (value >= 1e3) return `${Math.round(value / 1e3)} kB`;
  return `${value} B`;
}
