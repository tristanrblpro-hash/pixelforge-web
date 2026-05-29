import { PromptStudio } from "@/components/PromptStudio";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function PromptsPage() {
  return (
    <>
      <WorkspaceHeader
        title="Prompts"
        lede="Génère des prompts parfaits pour Nano Banana Pro, Kling 3.0 et Kling Avatars — un onglet par modèle."
      />
      <PromptStudio />
    </>
  );
}
