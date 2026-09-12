import { NavLink } from "react-router-dom";
import { Clapperboard, Home, Library, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/cn";
import { useWorkspace } from "@/store/workspace";

const nav = [
  { to: "/", label: "Início", icon: Home, end: true },
  { to: "/biblioteca", label: "Biblioteca", icon: Library, end: false },
];

export function TopBar() {
  const { projects, library, health, healthError } = useWorkspace();

  const badge = (to: string) => (to === "/biblioteca" ? library.length : 0);
  const degraded = Boolean(healthError) || health?.status === "degraded";

  return (
    <header className="flex shrink-0 items-center gap-2 rounded-full border border-line bg-surface p-2">
      <NavLink
        to="/"
        end
        title="Voltar para o início"
        className={({ isActive }) =>
          cn(
            "flex shrink-0 items-center gap-2.5 rounded-full py-1 pr-3 pl-1 transition-colors",
            isActive ? "bg-surface-2" : "hover:bg-surface-2/60",
          )
        }
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-accent text-accent-ink">
          <Clapperboard className="size-4" strokeWidth={2.2} />
        </span>
        <span className="hidden text-[15px] font-semibold tracking-tight sm:block">
          Clip<span className="text-accent">Forge</span>
        </span>
      </NavLink>

      <nav className="scroll-thin mx-auto flex w-max min-w-0 items-center gap-1 overflow-x-auto rounded-full bg-surface-2 p-1">
        {nav.map(({ to, label, icon: Icon, end }) => {
          const count = badge(to);
          return (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex h-9 shrink-0 items-center gap-2 rounded-full px-3.5 text-[13px] font-medium transition-colors",
                  isActive
                    ? "bg-accent text-accent-ink"
                    : "text-muted hover:bg-surface-3 hover:text-ink",
                )
              }
            >
              <Icon className="size-4" strokeWidth={1.9} />
              <span>{label}</span>
              {count > 0 ? (
                <span className="num rounded-full bg-surface px-1.5 text-[10px] font-bold">
                  {count}
                </span>
              ) : null}
            </NavLink>
          );
        })}
      </nav>

      <div className="flex shrink-0 items-center gap-1.5">
        <span className="hidden text-[12px] text-faint xl:block">
          {projects.length} projeto{projects.length === 1 ? "" : "s"}
        </span>

        <NavLink
          to="/ajustes"
          aria-label="Ajustes e diagnóstico"
          title={degraded ? "Ambiente com pendências" : "Ajustes e diagnóstico"}
          className={({ isActive }) =>
            cn(
              "relative flex size-10 items-center justify-center rounded-full transition-colors",
              isActive ? "bg-surface-2 text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
            )
          }
        >
          <SlidersHorizontal className="size-4" strokeWidth={1.9} />
          <span
            className={cn(
              "absolute top-2 right-2 size-2 rounded-full",
              degraded ? "bg-amber" : "bg-accent",
            )}
            aria-hidden
          />
        </NavLink>
      </div>
    </header>
  );
}
