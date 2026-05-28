import { AVATAR_MODELS } from "@/lib/models";
import { ModelCard, ModelsGrid, SectionTitle, WorkspaceHeader } from "@/components/ModelCard";
import { Placeholder } from "@/components/Placeholder";

export default function Page() {
  return (
    <>
      <WorkspaceHeader
        title="Kling Avatar"
        lede="Image + audio gives you a lip-synced talking head."
      />
      <Placeholder
        title="Phase 3 — later"
        hint="3-step upload (image, audio, prompt) + adaptive timeout based on audio duration."
      />
      <SectionTitle>Available avatar models</SectionTitle>
      <ModelsGrid>
        {Object.entries(AVATAR_MODELS).map(([key, m]) => (
          <ModelCard
            key={key}
            label={m.label}
            vendor={m.vendor}
            meta={`max ${m.maxAudioSeconds}s audio`}
            price={`$${m.pricePerSecond.toFixed(3)} / sec`}
          />
        ))}
      </ModelsGrid>
    </>
  );
}
