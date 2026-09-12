import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Pílula de filtro / status — o vocabulário visual do dashboard. */
export function Chip({
  children,
  active,
  onClick,
  className,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const Tag = onClick ? "button" : "span";

  return (
    <Tag
      onClick={onClick}
      aria-pressed={onClick ? Boolean(active) : undefined}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-[12px] font-medium whitespace-nowrap",
        "transition-colors duration-150",
        active
          ? "bg-accent text-accent-ink"
          : "bg-surface-2 text-muted hover:bg-surface-3 hover:text-ink",
        onClick && "cursor-pointer",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

export function Tag({ name }: { name: string }) {
  return (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[11px] text-faint">
      #{name}
    </span>
  );
}

/** Bolinha colorida de status — projeto, job, diagnóstico. */
export function Dot({ color, pulse }: { color: string; pulse?: boolean }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", pulse && "animate-pulse")}
      style={{ backgroundColor: color }}
    />
  );
}
