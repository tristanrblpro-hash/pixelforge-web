import { Placeholder } from "@/components/Placeholder";
import { WorkspaceHeader } from "@/components/ModelCard";

export default function Page() {
  return (
    <>
      <WorkspaceHeader
        title="Translate page"
        lede="Paste a URL, pick the images, translate or brand-swap."
      />
      <Placeholder
        title="Phase 3 — later"
        hint="Server-side scrape, dual bucket (products vs page), per-image retry, lock-while-running."
      />
    </>
  );
}
