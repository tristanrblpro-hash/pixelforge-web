import { WorkspaceHeader } from "@/components/ModelCard";
import { Placeholder } from "@/components/Placeholder";

type Batch = {
  batch_id: string;
  kind: string;
  status: string;
  cost_usd: number;
  created_at: string;
};

async function fetchHistory(): Promise<Batch[]> {
  // Server-component fetch — falls back to empty if the table doesn't exist yet.
  try {
    const url = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/batches?select=batch_id,kind,status,cost_usd,created_at&order=created_at.desc&limit=200`;
    const r = await fetch(url, {
      headers: {
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        Authorization: `Bearer ${process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!}`,
      },
      cache: "no-store",
    });
    if (!r.ok) return [];
    return (await r.json()) as Batch[];
  } catch {
    return [];
  }
}

export default async function Page() {
  const batches = await fetchHistory();

  return (
    <>
      <WorkspaceHeader
        title="History"
        lede="All past batches across every workspace."
      />
      {batches.length === 0 ? (
        <Placeholder
          title="No batches yet"
          hint="Run something to see it here. (If the Supabase table isn't created yet, you'll see this too.)"
        />
      ) : (
        <div className="text-sm">
          {batches.map((b) => (
            <div
              key={b.batch_id}
              className="grid grid-cols-[110px_1fr_110px_80px_1fr] gap-3 items-center py-2.5 border-b border-pf-border"
            >
              <span className="text-pf-accent font-semibold uppercase text-[11px]">{b.kind}</span>
              <span className="text-pf-muted font-mono text-xs">{b.batch_id}</span>
              <span
                className={
                  b.status === "completed"
                    ? "text-pf-ok font-semibold"
                    : b.status === "failed"
                    ? "text-pf-danger font-semibold"
                    : "text-pf-warn font-semibold"
                }
              >
                {b.status}
              </span>
              <span>${(b.cost_usd ?? 0).toFixed(3)}</span>
              <span className="text-pf-muted">{new Date(b.created_at).toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
