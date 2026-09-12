import { useEffect } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { JobDock } from "@/components/JobDock";
import { TopBar } from "@/components/layout/TopBar";

export function AppShell() {
  const { pathname } = useLocation();

  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [pathname]);

  return (
    <div className="min-h-dvh">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-3 px-3 pt-3 pb-32 sm:px-4">
        <TopBar />
        <main key={pathname} className="anim-rise">
          <Outlet />
        </main>
      </div>

      <JobDock />
    </div>
  );
}
