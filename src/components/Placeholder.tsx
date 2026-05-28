type Props = {
  title: string;
  hint: string;
};

export function Placeholder({ title, hint }: Props) {
  return (
    <div className="border border-dashed border-pf-border rounded-lg py-12 px-6 text-center text-pf-muted">
      <strong className="block mb-2 text-pf-dim font-semibold">{title}</strong>
      {hint}
    </div>
  );
}
