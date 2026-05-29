import { CopyStudio } from "@/components/CopyStudio";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function CopiesPage() {
  return (
    <>
      <WorkspaceHeader
        title="Ad Copies"
        lede="Du script vidéo aux 3 ad copies + 3 titres Meta. Patterns A/B prod déjà encodés par marque."
      />
      <CopyStudio />
    </>
  );
}
