import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";

export function PageHeader({
  title,
  subtitle,
  actions,
  back,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  back?: boolean;
}) {
  const navigate = useNavigate();

  return (
    <div className="flex shrink-0 flex-wrap items-end justify-between gap-3 px-1">
      <div className="flex min-w-0 items-center gap-3">
        {back ? (
          <Button
            variant="outline"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Voltar"
            className="mb-1"
          >
            <ArrowLeft className="size-4" strokeWidth={2} />
          </Button>
        ) : null}
        <div className="min-w-0">
          <h1 className="display truncate text-[27px] leading-tight sm:text-[32px]">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 pb-1">{actions}</div> : null}
    </div>
  );
}
