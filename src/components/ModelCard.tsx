type Props = {
  label: string;
  vendor: string;
  meta?: string;
  price: string;
};

export function ModelCard({ label, vendor, meta, price }: Props) {
  return (
    <div className="bg-pf-elev border border-pf-border rounded-lg p-3.5">
      <div className="font-semibold">{label}</div>
      <div className="text-xs text-pf-muted mt-0.5">{vendor}</div>
      {meta ? <div className="text-xs text-pf-muted mt-1.5">{meta}</div> : null}
      <div className="text-xs text-pf-accent font-semibold mt-2.5">{price}</div>
    </div>
  );
}

export function ModelsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-3">{children}</div>
  );
}

export function WorkspaceHeader({ title, lede }: { title: string; lede: string }) {
  return (
    <>
      <h1 className="text-[22px] font-bold mb-1">{title}</h1>
      <p className="text-pf-dim mb-7">{lede}</p>
    </>
  );
}

export function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[1.2px] text-pf-muted mt-8 mb-3">
      {children}
    </h2>
  );
}
