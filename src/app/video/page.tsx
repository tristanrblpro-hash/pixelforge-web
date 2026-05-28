import { VIDEO_MODELS } from "@/lib/models";
import { ModelCard, ModelsGrid, SectionTitle, WorkspaceHeader } from "@/components/ModelCard";
import { Placeholder } from "@/components/Placeholder";

function formatPricePerSecond(table: Record<string, number>) {
  const vals = Object.values(table);
  if (vals.length === 0) return "";
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  return min === max ? `$${min.toFixed(3)} / sec` : `$${min.toFixed(3)}–${max.toFixed(3)} / sec`;
}

export default function Page() {
  return (
    <>
      <WorkspaceHeader
        title="Video generation"
        lede="Text-to-video or image-to-video via Kling, Sora, Veo, Seedance."
      />
      <Placeholder
        title="Phase 2 — soon"
        hint="Model + duration + aspect ratio + audio toggle. Client-side polling for long jobs."
      />
      <SectionTitle>Available video models</SectionTitle>
      <ModelsGrid>
        {Object.entries(VIDEO_MODELS).map(([key, m]) => (
          <ModelCard
            key={key}
            label={m.label}
            vendor={m.vendor}
            meta={`${m.durations.join("s, ")}s · ${m.aspectRatios.join(" / ")}`}
            price={formatPricePerSecond(m.pricePerSecond)}
          />
        ))}
      </ModelsGrid>
    </>
  );
}
