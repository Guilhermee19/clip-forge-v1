import { ClipCard } from "@/components/ClipCard";
import type { RenderedClip } from "@/lib/types";

interface Props {
  clips: RenderedClip[];
  projectId?: string;
  showProject?: boolean;
  onDelete?: (clip: RenderedClip) => void;
}

/** Grade responsiva de cortes renderizados. */
export function ClipGrid({ clips, projectId, showProject, onDelete }: Props) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {clips.map((clip, index) => (
        <ClipCard
          key={clip.id ?? clip.video_path}
          clip={clip}
          index={index}
          projectId={projectId}
          showProject={showProject}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
