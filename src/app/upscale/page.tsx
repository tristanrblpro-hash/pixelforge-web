import { UPSCALE_MODELS } from "@/lib/models";
import { ModelCard, ModelsGrid, SectionTitle, WorkspaceHeader } from "@/components/ModelCard";
import { Placeholder } from "@/components/Placeholder";

export default function Page() {
  return (
    <>
      <WorkspaceHeader title="Upscale" lede="Topaz image or video upscaling." />
      <Placeholder
        title="Phase 3 — later"
        hint="Single-job pipeline. Factors 2× / 4× / 8× (image) and 2× / 4× (video)."
      />
      <SectionTitle>Available upscale models</SectionTitle>
      <ModelsGrid>
        {Object.entries(UPSCALE_MODELS).map(([key, m]) => {
          const price =
            m.pricePerImage != null
              ? `$${m.pricePerImage.toFixed(3)} / image`
              : `$${(m.pricePerSecond ?? 0).toFixed(3)} / sec`;
          return (
            <ModelCard
              key={key}
              label={m.label}
              vendor={m.vendor}
              meta={`Factors ${m.factors.map((f) => `${f}×`).join(", ")}`}
              price={price}
            />
          );
        })}
      </ModelsGrid>
    </>
  );
}
