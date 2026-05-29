import { BriefWizard } from "@/components/BriefWizard";

export const dynamic = "force-dynamic";

type PageProps = { params: Promise<{ id: string }> };

export default async function BriefDetailPage({ params }: PageProps) {
  const { id } = await params;
  return <BriefWizard id={id} />;
}
