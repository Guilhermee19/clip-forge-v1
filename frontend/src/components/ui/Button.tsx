import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

type Variant = "accent" | "solid" | "outline" | "ghost" | "danger";
type Size = "sm" | "md" | "lg" | "icon" | "iconSm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children?: ReactNode;
}

const variants: Record<Variant, string> = {
  accent: "bg-accent text-accent-ink hover:bg-accent-hover",
  solid: "bg-surface-2 text-ink hover:bg-surface-3",
  outline: "border border-line-strong text-ink hover:border-faint hover:bg-surface-2",
  ghost: "text-muted hover:text-ink hover:bg-surface-2",
  danger: "text-rose hover:bg-rose/10",
};

const sizes: Record<Size, string> = {
  sm: "h-8 gap-1.5 px-3.5 text-[12px]",
  md: "h-10 gap-2 px-4 text-[13px]",
  lg: "h-12 gap-2 px-6 text-sm",
  icon: "size-10",
  iconSm: "size-8",
};

export const buttonBase =
  "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-full font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-45";

export function buttonClasses(variant: Variant = "solid", size: Size = "md", className?: string) {
  return cn(buttonBase, variants[variant], sizes[size], className);
}

export function Button({
  variant = "solid",
  size = "md",
  className,
  children,
  ...props
}: ButtonProps) {
  return (
    <button className={buttonClasses(variant, size, className)} {...props}>
      {children}
    </button>
  );
}
