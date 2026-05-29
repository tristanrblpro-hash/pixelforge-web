import { CutSilenceStudio } from "@/components/CutSilenceStudio";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function CutSilencePage() {
  return (
    <>
      <WorkspaceHeader
        title="Cut Silence"
        lede="Vire les blancs d'une voix off pour un audio plus dynamique. 100% local, gratuit."
      />
      <CutSilenceStudio />
    </>
  );
}
