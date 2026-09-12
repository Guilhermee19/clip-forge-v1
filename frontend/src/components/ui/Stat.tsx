import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function Stat({
  label,
  value,
  suffix,
  className,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col justify-between gap-1.5", className)}>
      <p className="truncate text-[11px] text-muted">{label}</p>
      <p className="num display text-[26px] leading-none">
        {value}
        {suffix ? <span className="ml-1 text-[12px] font-medium text-faint">{suffix}</span> : null}
      </p>
    </div>
  );
}
