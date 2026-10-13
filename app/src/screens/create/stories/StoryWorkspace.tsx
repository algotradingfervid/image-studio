// STUB (Task 11): replaced at merge by the real workspace from Task 12. Keep this signature.
import type { JSX } from "react";
import type { ImageRecord } from "../../../api";
import type { JobView } from "../JobCard";

export function StoryWorkspace(props: { storyId: string | null; jobs: JobView[]; onOpenImage: (im: ImageRecord) => void; onChanged?: () => void }): JSX.Element {
  return (
    <div className="empty" data-story-id={props.storyId ?? undefined}>
      <p className="hint">{props.storyId ? "Story workspace (coming in Task 12)." : "Plan a story to see its shots here."}</p>
    </div>
  );
}
