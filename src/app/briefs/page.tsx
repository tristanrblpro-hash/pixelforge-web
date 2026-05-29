import { BriefsList } from "@/components/BriefsList";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function BriefsPage() {
  return (
    <>
      <WorkspaceHeader
        title="Briefs"
        lede="Organise tout : script, voix off, avatars IA, lipsyncs. Un brief = un livrable monteur."
      />
      <BriefsList />
    </>
  );
}
