import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Panel({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <section className={cn("hairline rounded-3xl border border-line bg-surface", className)}>
      {children}
    </section>
  );
}

export function PanelHeader({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between gap-4 px-5 pt-5 pb-4">
      <div className="min-w-0">
        <h2 className="truncate text-[15px] font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="mt-0.5 truncate text-[12px] text-faint">{hint}</p> : null}
      </div>
      {action}
    </header>
  );
}
