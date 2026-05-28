import { IMAGE_MODELS } from "@/lib/models";
import { ModelCard, ModelsGrid, SectionTitle, WorkspaceHeader } from "@/components/ModelCard";
import { Placeholder } from "@/components/Placeholder";

export default function Home() {
  return (
    <>
      <WorkspaceHeader
        title="Image generation"
        lede="Generate images from text prompts using any model in the KIE.ai catalog. Run up to 20 in parallel."
      />
      <Placeholder
        title="Phase 1 — coming next"
        hint="Text prompt, model selector, aspect ratio, batch parsing, accumulative gallery."
      />
      <SectionTitle>Available image models</SectionTitle>
      <ModelsGrid>
        {Object.entries(IMAGE_MODELS).map(([key, m]) => (
          <ModelCard
            key={key}
            label={m.label}
            vendor={m.vendor}
            meta={m.aspectRatios.join(" · ")}
            price={`$${m.pricePerImage.toFixed(3)} / image`}
          />
        ))}
      </ModelsGrid>
    </>
  );
}
