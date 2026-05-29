import { TranscribeStudio } from "@/components/TranscribeStudio";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function TranscribePage() {
  return (
    <>
      <WorkspaceHeader
        title="Transcribe"
        lede="Voix off ou vidéo → transcription texte. 100% local, gratuit (Whisper tourne dans ton navigateur)."
      />
      <TranscribeStudio />
    </>
  );
}
