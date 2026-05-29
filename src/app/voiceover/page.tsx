import { VoiceoverStudio } from "@/components/VoiceoverStudio";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function VoiceoverPage() {
  return (
    <>
      <WorkspaceHeader
        title="Voiceover"
        lede="Génère ta VO ElevenLabs depuis ta library, stockée dans Supabase, handoff direct vers Cut Silence."
      />
      <VoiceoverStudio />
    </>
  );
}
