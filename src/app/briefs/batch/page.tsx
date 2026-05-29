import { BriefBatchWizard } from "@/components/BriefBatchWizard";
import { WorkspaceHeader } from "@/components/ModelCard";

export const dynamic = "force-dynamic";

export default function BriefBatchPage() {
  return (
    <>
      <WorkspaceHeader
        title="Batch hebdo"
        lede="Crée tous tes briefs de la semaine d'un coup. Scripts, voix off, sync Notion — en flux guidé."
      />
      <BriefBatchWizard />
    </>
  );
}
