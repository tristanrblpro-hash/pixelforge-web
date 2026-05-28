import { Placeholder } from "@/components/Placeholder";
import { WorkspaceHeader } from "@/components/ModelCard";

export default function Page() {
  return (
    <>
      <WorkspaceHeader
        title="Batch image edit"
        lede="Upload N images + 1 prompt to edit them all in parallel."
      />
      <Placeholder
        title="Phase 1 — coming next"
        hint="Dropzone, optional reference logo, concurrent worker pool, retry per-image."
      />
    </>
  );
}
